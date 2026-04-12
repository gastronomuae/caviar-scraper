import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyWebhookSignature } from "@/lib/server/verifyShopifyWebhook";

/**
 * POST /api/webhooks/shop-redact
 * Shopify topic: shop/redact
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  const isDev = process.env.NODE_ENV !== "production";
  const testBypass = isDev && req.headers.get("x-test-webhook") === "true";
  if (testBypass) {
    console.info("[webhook][test_mode]", {
      route: "/api/webhooks/shop-redact",
      note: "HMAC bypassed for testing",
    });
  } else if (!verifyShopifyWebhookSignature(raw, hmacHeader)) {
    return new NextResponse(null, { status: 401 });
  }

  try {
    const json = JSON.parse(raw) as {
      shop_id?: number;
      shop_domain?: string;
    };
    console.info("[webhooks][shop-redact]", {
      shopId: json.shop_id,
      shopDomain: json.shop_domain,
    });
  } catch {
    console.warn("[webhooks][shop-redact] invalid JSON payload");
  }

  return new NextResponse(null, { status: 200 });
}
