import { NextRequest, NextResponse } from "next/server";
import { deleteStoredAccessToken, normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { verifyShopifyWebhookSignature } from "@/lib/server/verifyShopifyWebhook";

const SHOP_DOMAIN_RE = /^[a-zA-Z0-9-]+\.myshopify\.com$/;

/**
 * POST /api/webhooks/app-uninstalled
 *
 * Shopify APP_UNINSTALLED — raw body HMAC via X-Shopify-Hmac-Sha256 (same secret as OAuth).
 * Clears the shop's token entry in Redis (and in-memory fallback when used).
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhookSignature(raw, hmacHeader)) {
    return new NextResponse(null, { status: 401 });
  }

  let shop: string | undefined;
  try {
    const json = JSON.parse(raw) as {
      myshopify_domain?: string | null;
      domain?: string | null;
    };
    const d = json.myshopify_domain || json.domain;
    if (d && typeof d === "string") {
      shop = normalizeShopifyAdminDomain(d) || undefined;
    }
  } catch {
    /* ignore invalid JSON */
  }

  if (!shop || !SHOP_DOMAIN_RE.test(shop)) {
    console.warn("[webhook][app_uninstalled][invalid_shop]", {
      message: "missing or invalid domain in payload",
    });
    return new NextResponse(null, { status: 200 });
  }

  try {
    await deleteStoredAccessToken(shop);
    console.info("[webhook][app_uninstalled][success]", {
      shop,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[webhook][app_uninstalled][cleanup_error]", {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return new NextResponse(null, { status: 200 });
}
