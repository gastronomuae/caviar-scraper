import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { getBackup, deleteBackup } from "@/lib/server/shopifyBackupStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { logAppEvent } from "@/lib/server/appEventLogger";
import { pushSingleResource } from "@/lib/server/shopifyPush";

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkKey(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_SUPPORT_KEY;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

// ── Token resolution (internal — reads from stores table, no cookie needed) ───

async function resolveInternalToken(shop: string): Promise<string> {
  const { data, error } = await supabase
    .from("stores")
    .select("access_token")
    .eq("shop_domain", shop)
    .maybeSingle();

  if (error) throw new Error(`Supabase error: ${error.message}`);
  if (!data?.access_token) throw new Error(`No token stored for ${shop}`);
  return data.access_token;
}

// ── Shopify GraphQL helper ────────────────────────────────────────────────────

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
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Shopify GQL: ${json.errors[0].message}`);
  return json.data;
}

// ── POST /api/internal/restore ────────────────────────────────────────────────
// Body: { shopifyDomain, resourceId, locale, marketId?, fields? }
// Header: Authorization: Bearer <INTERNAL_SUPPORT_KEY>
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!checkKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    shopifyDomain: string;
    resourceId: string;
    locale: string;
    marketId?: string;
    fields?: string[];
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const shop = normalizeShopifyAdminDomain(body.shopifyDomain ?? "");
  const resourceId = (body.resourceId ?? "").trim();
  const locale = (body.locale ?? "").trim();
  const marketId = body.marketId?.trim() || undefined;

  if (!shop || !resourceId || !locale) {
    return NextResponse.json(
      { error: "Missing: shopifyDomain, resourceId, locale" },
      { status: 400 },
    );
  }

  let token: string;
  try {
    token = await resolveInternalToken(shop);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Token resolution failed" },
      { status: 401 },
    );
  }

  const backup = await getBackup(shop, resourceId, locale, marketId);
  if (!backup?.fields.length) {
    return NextResponse.json({ error: "No backup found for this resource" }, { status: 404 });
  }

  // Stale warning (24h)
  const ageMs = Date.now() - new Date(backup.backedUpAt).getTime();
  const staleWarning = ageMs > 24 * 60 * 60 * 1000
    ? `Backup is ${Math.round(ageMs / 3_600_000)}h old — may be stale`
    : null;

  const requestedKeys = body.fields?.length ? new Set(body.fields) : null;
  const fieldsToRestore = requestedKeys
    ? backup.fields.filter((f) => requestedKeys.has(f.key))
    : backup.fields;

  if (!fieldsToRestore.length) {
    return NextResponse.json({ error: "No matching fields in backup" }, { status: 422 });
  }

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
      { error: "No fields have a stored digest. Re-push to create a fresh backup." },
      { status: 422 },
    );
  }

  try {
    // Throttle-aware, retries on THROTTLED
    const pushResult = await pushSingleResource(shop, token, resourceId, translations, {
      batchIndex: 0,
      tag: "internal/restore",
    });

    if (pushResult.userErrors.length) {
      return NextResponse.json(
        { error: `Shopify rejected restore: ${pushResult.userErrors[0].message}` },
        { status: 422 },
      );
    }

    const restoredKeys = pushResult.fields;

    if (!requestedKeys) {
      await deleteBackup(shop, resourceId, locale, marketId);
    }

    console.info(
      `[internal/restore] shop=${shop} resource=${resourceId} locale=${locale} ` +
      `restored=${restoredKeys.length} fields: ${restoredKeys.join(", ")}`,
    );

    logAppEvent({
      shop_domain: shop,
      action:      "restore_success",
      status:      "ok",
      message:     `[internal] Restored ${restoredKeys.length} field(s) for resource ${resourceId}`,
      metadata:    { resourceId, locale, fields: restoredKeys, partial: !!requestedKeys },
    });

    return NextResponse.json({
      ok: true,
      restored: pushResult.pushed,
      fields: restoredKeys,
      partial: !!requestedKeys,
      backedUpAt: backup.backedUpAt,
      ...(staleWarning ? { warning: staleWarning } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    logAppEvent({
      shop_domain: shop,
      action:      "restore_error",
      status:      "error",
      message:     `[internal] Restore failed for resource ${resourceId}: ${msg}`,
      metadata:    { resourceId, locale },
    });
    return NextResponse.json(
      { error: msg },
      { status: 500 },
    );
  }
}
