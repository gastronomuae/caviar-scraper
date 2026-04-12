import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { supabase } from "@/lib/supabaseClient";
import { SHOPIFY_PLUS_ONLY_PREFIXES } from "@/lib/shopifySyncEngine";

/**
 * GET /api/debug/purge-plus-keys?shop=<domain>[&dry_run=true]
 * POST /api/debug/purge-plus-keys?shop=<domain>[&dry_run=true]
 *
 * Deletes stale Shopify Plus-only keys from the `backups` table for
 * ONLINE_STORE_THEME records. Run once after deploying the Plus-key filter
 * to purge rows that entered the DB before the filter was active.
 *
 * These keys (shopify.checkout.*, shopify.checkpoint.*, etc.) are
 * Shopify-controlled and cannot be translated on Basic/Standard plans.
 *
 * ?dry_run=true — count matching rows without deleting (safe to run first)
 * ?dry_run=false (default) — delete matching rows and return count
 *
 * Response shape:
 *   { shop, dry_run, prefixes, matchingRows, purged, message }
 */
async function handlePurgePlusKeys(req: NextRequest): Promise<NextResponse> {
  const rawShop = req.nextUrl.searchParams.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(rawShop);
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";

  if (!shop) {
    return NextResponse.json(
      { error: "Missing ?shop= parameter. Example: ?shop=my-store.myshopify.com" },
      { status: 400 },
    );
  }

  try {
    await resolveShopifyAccessToken({
      shopifyDomain: shop,
      cookieHeader: req.headers.get("cookie"),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token not found." },
      { status: 401 },
    );
  }

  // PostgREST OR filter — matches any row whose key starts with a Plus-only prefix.
  // Syntax: "key.like.shopify.checkout%,key.like.shopify.checkpoint%,..."
  const orFilter = SHOPIFY_PLUS_ONLY_PREFIXES.map(
    (prefix) => `key.like.${prefix}%`,
  ).join(",");

  try {
    // Always count first so the response always includes matchingRows.
    const { count: matchingRows, error: countError } = await supabase
      .from("backups")
      .select("id", { count: "exact", head: true })
      .eq("shop_domain", shop)
      .eq("resource_type", "ONLINE_STORE_THEME")
      .or(orFilter);

    if (countError) {
      return NextResponse.json(
        { error: `Supabase count failed: ${countError.message}` },
        { status: 500 },
      );
    }

    if (dryRun) {
      return NextResponse.json({
        shop,
        dry_run: true,
        prefixes: SHOPIFY_PLUS_ONLY_PREFIXES,
        matchingRows: matchingRows ?? 0,
        purged: 0,
        message:
          `${matchingRows ?? 0} rows would be deleted. ` +
          `Remove ?dry_run=true (or set ?dry_run=false) to apply.`,
      });
    }

    // Live delete.
    const { error: deleteError, count: purged } = await supabase
      .from("backups")
      .delete({ count: "exact" })
      .eq("shop_domain", shop)
      .eq("resource_type", "ONLINE_STORE_THEME")
      .or(orFilter);

    if (deleteError) {
      return NextResponse.json(
        { error: `Supabase delete failed: ${deleteError.message}` },
        { status: 500 },
      );
    }

    console.info(
      `[purge-plus-keys] shop=${shop} — purged ${purged ?? "?"} Plus-only ONLINE_STORE_THEME rows from backups`,
    );

    return NextResponse.json({
      shop,
      dry_run: false,
      prefixes: SHOPIFY_PLUS_ONLY_PREFIXES,
      matchingRows: matchingRows ?? 0,
      purged: purged ?? 0,
      message:
        `Purged ${purged ?? 0} Plus-only rows from backups table. ` +
        `Force re-sync ONLINE_STORE_THEME from the UI to refresh the client-side cache.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handlePurgePlusKeys(req);
}

export async function POST(req: NextRequest) {
  return handlePurgePlusKeys(req);
}
