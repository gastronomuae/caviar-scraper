import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";
import { getBackup, deleteBackup } from "@/lib/server/shopifyBackupStore";
import { logAppEvent } from "@/lib/server/appEventLogger";
import { pushSingleResource } from "@/lib/server/shopifyPush";

/** How old a backup must be (ms) before we log a stale warning. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

interface RestoreRequest {
  shopifyDomain: string;
  /** Shopify GID (gid://shopify/Product/…) or bare numeric id. */
  resourceId: string;
  resourceType?: string;
  locale: string;
  marketId?: string;
  /**
   * Optional subset of field keys to restore (partial restore).
   * When omitted, all backed-up fields are restored.
   */
  fields?: string[];
}

async function shopifyGql(
  domain: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
) {
  const res = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Shopify GraphQL error: ${json.errors[0].message}`);
  return json.data;
}

/** Re-fetch the current translations after restore to surface any fields still outdated. */
async function checkOutdatedAfterRestore(
  domain: string,
  token: string,
  resourceId: string,
  locale: string,
  restoredKeys: string[],
): Promise<void> {
  try {
    const data = await shopifyGql(domain, token, `
      query CheckOutdated($resourceId: ID!, $locale: String!) {
        translatableResource(resourceId: $resourceId) {
          translations(locale: $locale) {
            key
            value
            outdated
          }
        }
      }
    `, { resourceId, locale });

    const translations: Array<{ key: string; value: string; outdated?: boolean }> =
      data?.translatableResource?.translations ?? [];

    const outdatedAfterRestore = translations.filter(
      (t) => restoredKeys.includes(t.key) && t.outdated,
    );

    if (outdatedAfterRestore.length) {
      console.warn(
        `[backup/restore] ${outdatedAfterRestore.length} field(s) still outdated after restore ` +
          `(source content changed since backup): ${outdatedAfterRestore.map((t) => t.key).join(", ")}`,
      );
    } else {
      console.info(`[backup/restore] all restored fields are current (no outdated flag)`);
    }
  } catch (e) {
    console.warn("[backup/restore] post-restore outdated check failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * POST /api/shopify/backup/restore
 *
 * Restores backed-up translations back to Shopify using stored field values
 * and stored source digests — no extra Shopify round-trip required for digests.
 *
 * Body: { shopifyDomain, resourceId, locale, resourceType?, marketId?, fields? }
 *
 * - If `fields` is provided, only those field keys are restored (partial restore).
 * - Warns in server logs if the backup is older than 24 hours.
 * - After a successful restore, re-fetches translations and logs any still-outdated fields.
 * - Deletes the backup record on success so the restore button is hidden.
 */
export async function POST(req: NextRequest) {
  let body: RestoreRequest;
  try {
    body = (await req.json()) as RestoreRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawDomain = (body.shopifyDomain ?? "")
    .replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
  const shop = normalizeShopifyAdminDomain(rawDomain);
  const resourceId = (body.resourceId ?? "").trim();
  const locale = (body.locale ?? "").trim();
  const marketId = body.marketId?.trim() || undefined;

  if (!shop || !resourceId || !locale) {
    return NextResponse.json(
      { error: "Missing required fields: shopifyDomain, resourceId, locale" },
      { status: 400 },
    );
  }

  // Resolve OAuth token
  let token: string;
  try {
    const resolved = await resolveShopifyAccessToken({
      shopifyDomain: shop,
      cookieHeader: req.headers.get("cookie"),
    });
    token = resolved.token;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not resolve Shopify token" },
      { status: 401 },
    );
  }

  // Load backup
  const backup = await getBackup(shop, resourceId, locale, marketId);
  if (!backup || !backup.fields.length) {
    return NextResponse.json(
      { error: "No backup found for this resource. Push at least once to create a backup." },
      { status: 404 },
    );
  }

  // Stale warning
  const ageMs = Date.now() - new Date(backup.backedUpAt).getTime();
  if (ageMs > STALE_THRESHOLD_MS) {
    const hours = Math.round(ageMs / (60 * 60 * 1000));
    console.warn(
      `[backup/restore] Backup may be stale — another actor may have modified translations. ` +
        `Backup is ${hours}h old (resourceId=${resourceId} locale=${locale}).`,
    );
  }

  try {
    // Select fields (full or partial restore)
    const requestedKeys = body.fields?.length ? new Set(body.fields) : null;
    const fieldsToRestore = requestedKeys
      ? backup.fields.filter((f) => requestedKeys.has(f.key))
      : backup.fields;

    if (!fieldsToRestore.length) {
      return NextResponse.json(
        { error: requestedKeys ? "None of the requested fields exist in the backup." : "Backup has no fields." },
        { status: 422 },
      );
    }

    // Use the stored source digest — no re-fetch needed
    const translations = fieldsToRestore
      .filter((f) => f.value.trim() && f.sourceDigest)
      .map((f) => ({
        locale,
        key: f.key,
        value: f.value,
        translatableContentDigest: f.sourceDigest,
      }));

    if (!translations.length) {
      return NextResponse.json(
        { error: "No backup fields have a stored digest. Re-push to create a fresh backup." },
        { status: 422 },
      );
    }

    // Register translations (restore) — throttle-aware, retries on THROTTLED
    const pushResult = await pushSingleResource(shop, token, resourceId, translations, {
      batchIndex: 0,
      tag: "backup/restore",
    });

    if (pushResult.userErrors.length) {
      return NextResponse.json(
        { error: `Shopify rejected the restore: ${pushResult.userErrors[0].message}` },
        { status: 422 },
      );
    }

    const restoredKeys = pushResult.fields;

    // Post-restore: log any fields still outdated
    await checkOutdatedAfterRestore(shop, token, resourceId, locale, restoredKeys);

    // Clear backup on success (only if full restore, not partial)
    if (!requestedKeys) {
      await deleteBackup(shop, resourceId, locale, marketId);
    }

    logAppEvent({
      shop_domain: shop,
      action:      "restore_success",
      status:      "ok",
      message:     `Restored ${restoredKeys.length} field(s) for resource ${resourceId}`,
      metadata:    { resourceId, locale, fields: restoredKeys, partial: !!requestedKeys },
    });

    return NextResponse.json({
      ok: true,
      restored: pushResult.pushed,
      fields: restoredKeys,
      partial: !!requestedKeys,
      backedUpAt: backup.backedUpAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    logAppEvent({
      shop_domain: shop,
      action:      "restore_error",
      status:      "error",
      message:     `Restore failed for resource ${resourceId}: ${msg}`,
      metadata:    { resourceId, locale },
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
