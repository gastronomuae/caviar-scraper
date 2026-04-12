import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyWebhookSignature } from "@/lib/server/verifyShopifyWebhook";

/**
 * POST /api/webhooks/customers-data-request
 * Shopify topic: customers/data_request
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  const isDev = process.env.NODE_ENV !== "production";
  const testBypass = isDev && req.headers.get("x-test-webhook") === "true";
  if (testBypass) {
    console.info("[webhook][test_mode]", {
      route: "/api/webhooks/customers-data-request",
      note: "HMAC bypassed for testing",
    });
  } else if (!verifyShopifyWebhookSignature(raw, hmacHeader)) {
    return new NextResponse(null, { status: 401 });
  }

  try {
    const json = JSON.parse(raw) as {
      shop_id?: number;
      shop_domain?: string;
      orders_requested?: unknown[];
      customer?: unknown;
      data_request?: { id?: number };
    };
    console.info("[webhooks][customers-data-request]", {
      shopId: json.shop_id,
      shopDomain: json.shop_domain,
      dataRequestId: json.data_request?.id,
      hasCustomerPayload: !!json.customer,
      ordersRequestedCount: Array.isArray(json.orders_requested) ? json.orders_requested.length : 0,
    });
  } catch {
    console.warn("[webhooks][customers-data-request] invalid JSON payload");
  }

  return new NextResponse(null, { status: 200 });
}
