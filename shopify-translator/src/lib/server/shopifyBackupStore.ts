import { getRedis } from "@/lib/redis";
import { supabase } from "@/lib/supabaseClient";

// ── Resource type guard ────────────────────────────────────────────────────

/**
 * Allowlist of resource types for which backup snapshots are captured.
 * All other types are silently skipped — no Supabase writes, no blocking.
 *
 * Rationale for exclusions:
 *  METAFIELD / METAOBJECT  — too many records; Supabase writes block the
 *                            sync long enough to hit Vercel's 300 s timeout.
 *  MEDIA_IMAGE             — alt text only; restoration is low-value.
 *  ARTICLE / BLOG / MENU   — low restore frequency; can be re-translated cheaply.
 */
export const BACKUP_SUPPORTED_TYPES = new Set([
  "PRODUCT",
  "COLLECTION",
  "PAGE",
  "ONLINE_STORE_THEME",
]);

export function shouldBackupResourceType(resourceType: string): boolean {
  return BACKUP_SUPPORTED_TYPES.has(resourceType.toUpperCase());
}

// ── Data types ─────────────────────────────────────────────────────────────

export interface BackupField {
  key: string;
  /** Current translated value fetched live from Shopify immediately before overwrite. */
  value: string;
  /** SHA-256 digest from translatableContent — stored so restore never needs a re-fetch. */
  sourceDigest: string;
  /** Whether Shopify marked this translation as outdated at the time of backup. */
  outdated?: boolean;
}

export interface BackupRecord {
  shop: string;
  /** Shopify GID, e.g. gid://shopify/Product/123. */
  resourceId: string;
  resourceType: string;
  locale: string;
  /** Present when the push targeted a specific Shopify market. */
  marketId?: string;
  fields: BackupField[];
  /** ISO 8601 timestamp set when the backup was captured. */
  backedUpAt: string;
}

// ── Storage key ────────────────────────────────────────────────────────────

/**
 * Unique key per (shop, resource, locale[, market]).
 * v2 prefix prevents collisions with the previous simpler schema.
 */
function backupKey(
  shop: string,
  resourceId: string,
  locale: string,
  marketId?: string,
): string {
  const base = `shopify_backup::v2::${shop}::${resourceId}::${locale}`;
  return marketId ? `${base}::${marketId}` : base;
}

const memoryFallback = new Map<string, BackupRecord>();

// ── Type-level backup tracking (Supabase: backup_captures) ────────────────
// Tracks whether every resource of a given type has been captured in a sync.
// Once set, subsequent syncs skip backup capture for that type, preserving
// the original pre-push state.

/** Returns true if all resources of this type have already been backed up for this locale. */
export async function hasBackupForType(
  shop: string,
  resourceType: string,
  locale: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("backup_captures")
    .select("id")
    .eq("shop_domain", shop)
    .eq("resource_type", resourceType)
    .eq("locale", locale)
    .maybeSingle();

  if (error) {
    console.warn(`[shopifyBackupStore] hasBackupForType error: ${error.message}`);
    return false;
  }
  return data !== null;
}

/** Marks a resource type as fully backed up for this shop + locale. */
export async function markTypeBackedUp(
  shop: string,
  resourceType: string,
  locale: string,
): Promise<void> {
  const { error } = await supabase
    .from("backup_captures")
    .upsert(
      { shop_domain: shop, resource_type: resourceType, locale },
      { onConflict: "shop_domain,resource_type,locale" },
    );

  if (error) {
    throw new Error(`[shopifyBackupStore] markTypeBackedUp failed: ${error.message}`);
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/** Returns true if a backup already exists for this (shop, resource, locale[, market]). */
export async function hasBackup(
  shop: string,
  resourceId: string,
  locale: string,
  marketId?: string,
): Promise<boolean> {
  const key = backupKey(shop, resourceId, locale, marketId);
  const redis = getRedis();
  if (redis) {
    const v = await redis.get(key);
    return v !== null;
  }
  return memoryFallback.has(key);
}

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff.
 * Delays: 200 ms → 400 ms → 800 ms (first attempt is immediate).
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function saveBackup(record: BackupRecord): Promise<void> {
  if (!record.fields.length) return;

  const rows = record.fields.map((f) => ({
    shop_domain:   record.shop,
    resource_id:   record.resourceId,
    resource_type: record.resourceType,
    locale:        record.locale,
    ...(record.marketId ? { market_id: record.marketId } : {}),
    key:           f.key,
    value:         f.value,
    source_digest: f.sourceDigest,
    outdated:      f.outdated ?? null,
    backed_up_at:  record.backedUpAt,
  }));

  await withRetry(async () => {
    const { error } = await supabase.from("backups").upsert(rows, {
      onConflict: "shop_domain,resource_id,locale,key",
      ignoreDuplicates: true,
    });
    if (error) {
      throw new Error(`[shopifyBackupStore] saveBackup failed: ${error.message}`);
    }
  });
}

export async function getBackup(
  shop: string,
  resourceId: string,
  locale: string,
  marketId?: string,
): Promise<BackupRecord | null> {
  let query = supabase
    .from("backups")
    .select("resource_type, market_id, key, value, source_digest, outdated, backed_up_at")
    .eq("shop_domain", shop)
    .eq("resource_id", resourceId)
    .eq("locale", locale);

  if (marketId) {
    query = query.eq("market_id", marketId);
  } else {
    query = query.is("market_id", null);
  }

  const { data, error } = await query;

  if (error) {
    console.warn(`[shopifyBackupStore] getBackup error: ${error.message}`);
    return null;
  }
  if (!data || data.length === 0) return null;

  return {
    shop,
    resourceId,
    resourceType: data[0].resource_type,
    locale,
    ...(marketId ? { marketId } : {}),
    fields: data.map((row: { key: string; value: string; source_digest: string; outdated: boolean | null }) => ({
      key:          row.key,
      value:        row.value,
      sourceDigest: row.source_digest,
      ...(row.outdated !== null ? { outdated: row.outdated } : {}),
    })),
    backedUpAt: data[0].backed_up_at,
  };
}

export async function deleteBackup(
  shop: string,
  resourceId: string,
  locale: string,
  marketId?: string,
): Promise<void> {
  let query = supabase
    .from("backups")
    .delete()
    .eq("shop_domain", shop)
    .eq("resource_id", resourceId)
    .eq("locale", locale);

  if (marketId) {
    query = query.eq("market_id", marketId);
  } else {
    query = query.is("market_id", null);
  }

  const { error } = await query;
  if (error) {
    throw new Error(`[shopifyBackupStore] deleteBackup failed: ${error.message}`);
  }
}
