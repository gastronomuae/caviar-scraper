import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { SOURCE_LOCALE, TARGET_LOCALE } from "@/lib/storeConfig";
import {
  runShopifySync,
  getCachedSync,
  setCachedSync,
  parseSyncTypesQueryParam,
  normalizeNestedProductSyncTypes,
  type SyncBackupRawItem,
} from "@/lib/shopifySyncEngine";
import { resolveShopifyAccessToken, handleShopify401 } from "@/lib/server/resolveShopifyAccessToken";
import type { ShopifySyncProductRow, ShopifySyncResourceType } from "@/types";
import {
  hasBackupForType,
  markTypeBackedUp,
  saveBackup,
  shouldBackupResourceType,
  type BackupField,
} from "@/lib/server/shopifyBackupStore";
import { logAppEvent } from "@/lib/server/appEventLogger";

/** @deprecated Use ShopifySyncProductRow from @/types — kept for imports from this route. */
export type SyncedProductRow = ShopifySyncProductRow;

// ── Backup-at-sync-time helper ─────────────────────────────────────────────

/** Max parallel Supabase upserts. Keeps Cloudflare/Supabase from 502-ing. */
const BACKUP_CONCURRENCY = 10;

/**
 * Runs `tasks` with at most `concurrency` promises in flight at a time.
 * Returns results in the same order as the input array.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
  return results;
}

/**
 * Stores backup records for all items of a resource type using the raw data
 * already fetched during sync — no additional GraphQL calls.
 *
 * Only runs once per (shop, resourceType, targetLocale); subsequent syncs
 * skip capture because the type is marked as done in Redis / memory.
 */
async function handleTypeComplete(
  shop: string,
  locale: string,
  resourceType: string,
  items: SyncBackupRawItem[],
  force = false,
): Promise<void> {
  if (!shouldBackupResourceType(resourceType)) {
    console.info(`[sync/backup] type=${resourceType} — skipped (not a backup-supported type)`);
    return;
  }

  if (!force) {
    const alreadyDone = await hasBackupForType(shop, resourceType, locale);
    if (alreadyDone) {
      console.info(`[sync/backup] type=${resourceType} already backed up — skipping`);
      return;
    }
  } else {
    console.info(`[sync/backup] type=${resourceType} force=true — overwriting backup`);
  }

  const tasks: (() => Promise<void>)[] = [];
  for (const item of items) {
    const digestByKey = new Map(
      item.content
        .filter((c): c is { key: string; digest: string } => !!c.digest)
        .map((c) => [c.key, c.digest]),
    );
    const fields: BackupField[] = item.translations
      .filter((t): t is typeof t & { value: string } => !!(t.value?.trim()) && digestByKey.has(t.key))
      .map((t) => ({
        key: t.key,
        value: t.value,
        sourceDigest: digestByKey.get(t.key)!,
        ...(t.outdated !== undefined ? { outdated: t.outdated } : {}),
      }));
    if (!fields.length) continue;
    tasks.push(() =>
      saveBackup({
        shop,
        resourceId: item.resourceId,
        resourceType,
        locale,
        fields,
        backedUpAt: new Date().toISOString(),
      }),
    );
  }

  if (tasks.length === 0) {
    console.info(`[sync/backup] type=${resourceType} — no existing translations to back up, skipping mark`);
    return;
  }
  const results = await runWithConcurrency(tasks, BACKUP_CONCURRENCY);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.warn(
      `[sync/backup] type=${resourceType} — ${failed.length}/${tasks.length} saveBackup calls failed:`,
      (failed[0] as PromiseRejectedResult).reason,
    );
  }
  await markTypeBackedUp(shop, resourceType, locale);
  console.info(`[sync/backup] type=${resourceType} — backed up ${tasks.length - failed.length}/${tasks.length} resource(s)`);
}

/**
 * Returns an `onTypeComplete` callback bound to a specific shop + locale.
 * When `forceBackup=true` the "already backed up" guard is bypassed so existing
 * backup records are overwritten with fresh data.
 * Errors are caught and logged so they never interrupt the sync.
 */
function makeOnTypeComplete(shop: string, locale: string, forceBackup = false) {
  return async (resourceType: string, items: SyncBackupRawItem[]): Promise<void> => {
    try {
      await handleTypeComplete(shop, locale, resourceType, items, forceBackup);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sync/backup] backup failed for type=${resourceType}:`, msg);
      logAppEvent({
        shop_domain: shop,
        action:      "backup_error",
        status:      "error",
        message:     `Backup capture failed for ${resourceType}: ${msg}`,
        metadata:    { resourceType, locale },
      });
    }
  };
}

/**
 * Builds a zero-argument async function that runs all buffered backup items
 * in the background (called via `after()` so it fires after the response).
 */
function makeBackupTask(
  backlog: Array<{ resourceType: string; items: SyncBackupRawItem[] }>,
  shop: string,
  locale: string,
  forceBackup: boolean,
): () => Promise<void> {
  return async () => {
    const t0 = Date.now();
    const onTypeComplete = makeOnTypeComplete(shop, locale, forceBackup);
    await Promise.all(
      backlog.map(({ resourceType, items }) => onTypeComplete(resourceType, items)),
    );
    console.info(`[sync/background] backup complete in ${Date.now() - t0}ms`);
  };
}

/** Same normalization as `src/app/api/shopify/push/route.ts`. */
function normalizeShopifyDomain(raw: string): string {
  const cleanDomain = (raw ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
  if (!cleanDomain) return "";
  return cleanDomain.includes(".myshopify.com") ? cleanDomain : `${cleanDomain}.myshopify.com`;
}

function syncCacheKey(
  domain: string,
  token: string,
  types?: ShopifySyncResourceType[],
  targetLocale?: string,
  updatedAtFilter?: string,
): string {
  const scope =
    types === undefined || types.length === 0 ? "all" : [...types].sort().join(",");
  const loc = targetLocale ?? TARGET_LOCALE;
  const filter = updatedAtFilter ? `:inc:${updatedAtFilter}` : "";
  return `${domain}:${token.slice(0, 16)}:${scope}:${loc}${filter}`;
}

interface SyncRequestBody {
  shopifyDomain?: string;
  /** Legacy fields kept for backward compatibility; OAuth token is required. */
  shopifyClientId?: string;
  shopifyClientSecret?: string;
  /** When true, respond with NDJSON stream (progress + complete). */
  stream?: boolean;
  /** Optional resource filter, e.g. `"PRODUCT"` — same rules as parseSyncTypesQueryParam. */
  type?: string;
  /** Target locale for translations, e.g. "en". Falls back to TARGET_LOCALE env default. */
  targetLocale?: string;
  /**
   * When set, appended to the Shopify products query for incremental sync.
   * Example: ISO string "2025-04-01T12:00:00Z" → products query gets "updated_at:>=2025-04-01T12:00:00Z".
   * Only affects the PRODUCT pipeline.
   */
  updatedAtFilter?: string;
  /**
   * When true, bypass the in-memory result cache so Shopify is re-fetched.
   * Does NOT affect the backup guard — use forceBackup for that separately.
   */
  force?: boolean;
  /**
   * When true, bypass the "already backed up" type guard so the backup snapshot
   * is overwritten with the fresh sync data.
   * Independent of `force` — can be set without triggering a cache bypass.
   */
  forceBackup?: boolean;
}

/**
 * POST /api/shopify/sync
 * Lists products with source + target locale fields (same Admin GraphQL as engine).
 *
 * Body JSON:
 * - `shopifyDomain` (required) — token resolved from server-side OAuth store/cookie.
 * - `shopifyClientId` / `shopifyClientSecret` are ignored in OAuth-only mode.
 * - `stream` (optional) — NDJSON progress.
 * - `type` (optional) — e.g. `"PRODUCT"`.
 */
export async function POST(req: NextRequest) {
  let body: SyncRequestBody;
  try {
    body = (await req.json()) as SyncRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const domain = normalizeShopifyDomain(body.shopifyDomain ?? "");

  if (!domain) {
    return NextResponse.json(
      { error: "Missing shopifyDomain. Set your store in Settings, then sync again." },
      { status: 400 }
    );
  }

  let token: string;
  try {
    const resolved = await resolveShopifyAccessToken({
      shopifyDomain: domain,
      shopifyClientId: body.shopifyClientId,
      shopifyClientSecret: body.shopifyClientSecret,
      cookieHeader: req.headers.get("cookie"),
    });
    token = resolved.token;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not resolve Shopify token";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const parsedTypes = parseSyncTypesQueryParam(body.type ?? null);
  if (!parsedTypes.ok) {
    return NextResponse.json({ error: parsedTypes.error }, { status: 400 });
  }
  const syncTypes = parsedTypes.types
    ? normalizeNestedProductSyncTypes(parsedTypes.types)
    : undefined;

  const targetLocale =
    typeof body.targetLocale === "string" && body.targetLocale.trim()
      ? body.targetLocale.trim()
      : TARGET_LOCALE;

  const updatedAtFilter =
    typeof body.updatedAtFilter === "string" && body.updatedAtFilter.trim()
      ? body.updatedAtFilter.trim()
      : undefined;
  const productQueryFilter = updatedAtFilter ? `updated_at:>=${updatedAtFilter}` : undefined;

  const cacheKey = syncCacheKey(domain, token, syncTypes, targetLocale, updatedAtFilter);
  const useStream = body.stream === true;
  const force       = body.force       === true;
  const forceBackup = body.forceBackup === true;

  if (force)       console.info(`[sync] force=true — bypassing result cache for scope=${syncTypes?.join(",") ?? "all"}`);
  if (forceBackup) console.info(`[sync] forceBackup=true — backup guard bypassed; snapshot will be overwritten`);

  if (useStream) {
    const enc = new TextEncoder();
    const streamBody = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, unknown>) =>
          controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        try {
          const cached = !force ? getCachedSync(cacheKey) : null;
          if (cached) {
            send({
              type: "progress",
              processed: cached.length,
              total: cached.length,
              pct: 100,
              cached: true,
            });
            send({ type: "complete", products: cached });
            controller.close();
            return;
          }

          // Buffer backup items; stream rows per-type as they complete.
          const backlog: Array<{ resourceType: string; items: SyncBackupRawItem[] }> = [];
          const products = await runShopifySync({
            domain,
            token,
            sourceLocale: SOURCE_LOCALE,
            targetLocale,
            types: syncTypes,
            productQueryFilter,
            onProgress: (p) =>
              send({
                type: "progress",
                processed: p.processed,
                total: p.total,
                pct: p.pct,
                cached: false,
              }),
            onTypeComplete: async (resourceType, items) => {
              backlog.push({ resourceType, items });
            },
            // Stream each type's rows as soon as it finishes — client can render
            // PRODUCT results at ~45 s without waiting for METAOBJECT / METAFIELD.
            onTypeRowsReady: (resourceType, rows) => {
              if (rows.length > 0) {
                send({ type: "typeRows", resourceType, rows, count: rows.length });
              }
            },
          });
          setCachedSync(cacheKey, products);
          logAppEvent({
            shop_domain: domain,
            action:      "sync_complete",
            status:      "ok",
            message:     `Sync completed: ${products.length} resource(s)`,
            metadata:    { count: products.length, types: syncTypes ?? "all" },
          });
          // Phase 1 — respond immediately (rows already streamed per-type).
          // Phase 2 — backup fires after stream closes.
          after(makeBackupTask(backlog, domain, targetLocale, forceBackup));
          // Send final "complete" with no rows payload — client has everything.
          send({ type: "complete", totalCount: products.length });
          controller.close();
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          const is401 = message.includes("401") || message.toLowerCase().includes("invalid api key");
          if (is401) { void handleShopify401(domain); }
          logAppEvent({
            shop_domain: domain,
            action:      "sync_error",
            status:      "error",
            message:     `Sync failed: ${message}`,
            metadata:    { types: syncTypes ?? "all" },
          });
          send({ type: "error", message: is401 ? "Token expired or revoked — please reconnect in Settings." : message });
          controller.close();
        }
      },
    });

    return new Response(streamBody, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const cached = !force ? getCachedSync(cacheKey) : null;
    if (cached) {
      return NextResponse.json(cached);
    }
    // Buffer onTypeComplete calls — backup runs after the response is sent.
    const backlog: Array<{ resourceType: string; items: SyncBackupRawItem[] }> = [];
    const products = await runShopifySync({
      domain,
      token,
      sourceLocale: SOURCE_LOCALE,
      targetLocale,
      types: syncTypes,
      productQueryFilter,
      onTypeComplete: async (resourceType, items) => {
        backlog.push({ resourceType, items });
      },
    });
    setCachedSync(cacheKey, products);
    logAppEvent({
      shop_domain: domain,
      action:      "sync_complete",
      status:      "ok",
      message:     `Sync completed: ${products.length} resource(s)`,
      metadata:    { count: products.length, types: syncTypes ?? "all" },
    });
    // Phase 1 — respond immediately; Phase 2 — backup fires after response.
    after(makeBackupTask(backlog, domain, targetLocale, forceBackup));
    return NextResponse.json(products);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const is401 = msg.includes("401") || msg.toLowerCase().includes("invalid api key");
    if (is401) { void handleShopify401(domain); }
    logAppEvent({
      shop_domain: domain,
      action:      "sync_error",
      status:      "error",
      message:     `Sync failed: ${msg}`,
      metadata:    { types: syncTypes ?? "all" },
    });
    return NextResponse.json(
      { error: is401 ? "Token expired or revoked — please reconnect in Settings." : msg },
      { status: is401 ? 401 : 502 }
    );
  }
}
