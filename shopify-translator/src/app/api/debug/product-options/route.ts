import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

const API_VERSION = SHOPIFY_ADMIN_API_VERSION;

async function gql(
  shop: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ httpStatus: number; data: unknown; errors: unknown[] | null }> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const rawText = await res.text();
  let parsed: { data?: unknown; errors?: unknown[] } = {};
  try { parsed = JSON.parse(rawText) as typeof parsed; } catch { /* non-JSON */ }
  return { httpStatus: res.status, data: parsed.data ?? null, errors: parsed.errors ?? null };
}

function buildQuery(resourceType: "PRODUCT_OPTION" | "PRODUCT_OPTION_VALUE"): string {
  const queryName = resourceType === "PRODUCT_OPTION" ? "ProductOptionPage" : "ProductOptionValuePage";
  return `
    query ${queryName}($first: Int!, $after: String, $locale: String!) {
      translatableResources(resourceType: ${resourceType}, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          resourceId
          translatableContent { key value digest locale }
          translations(locale: $locale) { key value outdated }
        }
      }
    }
  `;
}

function extractConn(data: unknown): {
  pageInfo: unknown;
  nodeCount: number;
  nodes: unknown[];
} {
  const conn = (data as { translatableResources?: { pageInfo: unknown; nodes?: unknown[] } })
    ?.translatableResources;
  return {
    pageInfo: conn?.pageInfo ?? null,
    nodeCount: (conn?.nodes ?? []).length,
    nodes: conn?.nodes ?? [],
  };
}

/**
 * GET /api/debug/product-options
 *
 * Query params:
 *   shop         — required, e.g. my-store.myshopify.com
 *   locale       — target translation locale to inspect (default "en")
 *   type         — "OPTION" | "VALUE" | "BOTH" (default "BOTH")
 *   first        — page size, max 50 (default 10)
 *   after        — backward-compat cursor; used for OPTION when type=OPTION, VALUE when type=VALUE
 *   optionAfter  — cursor for PRODUCT_OPTION pagination (used when type=BOTH or type=OPTION)
 *   valueAfter   — cursor for PRODUCT_OPTION_VALUE pagination (used when type=BOTH or type=VALUE)
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;

  const rawShop = p.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(rawShop);
  if (!shop) {
    return NextResponse.json({ error: "Missing ?shop= parameter." }, { status: 400 });
  }

  let token: string;
  try {
    const resolved = await resolveShopifyAccessToken({
      shopifyDomain: shop,
      cookieHeader: req.headers.get("cookie"),
    });
    token = resolved.token;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token not found." },
      { status: 401 },
    );
  }

  const locale      = p.get("locale") ?? "en";
  const type        = (p.get("type") ?? "BOTH").toUpperCase();
  const first       = Math.min(50, parseInt(p.get("first") ?? "10", 10));
  // Shared backward-compat cursor; also used as per-type fallback.
  const after       = p.get("after")       ?? null;
  const optionAfter = p.get("optionAfter") ?? after;
  const valueAfter  = p.get("valueAfter")  ?? after;

  const results: Record<string, unknown> = {
    shop,
    apiVersion: API_VERSION,
    locale,
    params: { type, first, optionAfter, valueAfter },
  };

  if (type === "OPTION" || type === "BOTH") {
    const vars = { first, after: optionAfter, locale };
    const r = await gql(shop, token, buildQuery("PRODUCT_OPTION"), vars);
    results.PRODUCT_OPTION = { httpStatus: r.httpStatus, errors: r.errors, ...extractConn(r.data) };
  }

  if (type === "VALUE" || type === "BOTH") {
    const vars = { first, after: valueAfter, locale };
    const r = await gql(shop, token, buildQuery("PRODUCT_OPTION_VALUE"), vars);
    results.PRODUCT_OPTION_VALUE = { httpStatus: r.httpStatus, errors: r.errors, ...extractConn(r.data) };
  }

  return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
}
