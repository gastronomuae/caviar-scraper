import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken, normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

/**
 * GET /api/products?shop=<myshopify-domain>
 *
 * Quick connection-health check. Fetches the first 5 products from Shopify
 * using the stored access token for the given shop.
 *
 * Returns { connected: true, productCount: n, products: [...] }
 *      or { connected: false, error: "..." }
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(raw);

  if (!shop) {
    return NextResponse.json({ connected: false, error: "Missing shop query parameter." }, { status: 400 });
  }

  const token = await getStoredAccessToken(shop);
  if (!token) {
    return NextResponse.json(
      {
        connected: false,
        error: `No access token found for ${shop}. Install the app or connect via Settings.`,
      },
      { status: 401 }
    );
  }

  try {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/products.json?limit=5&fields=id,title,status`,
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { connected: false, error: `Shopify responded ${res.status}: ${body}` },
        { status: 502 }
      );
    }

    const data = (await res.json()) as { products: Array<{ id: number; title: string; status: string }> };
    return NextResponse.json({
      connected: true,
      shop,
      productCount: data.products.length,
      products: data.products,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ connected: false, error: msg }, { status: 500 });
  }
}
