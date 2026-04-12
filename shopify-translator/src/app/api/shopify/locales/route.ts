import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken, isShopify401, handleShopify401 } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

const API_VERSION = SHOPIFY_ADMIN_API_VERSION;

export interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

// Module-level cache: shop → { locales, fetchedAt }
const cache = new Map<string, { locales: ShopLocale[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const QUERY = `#graphql
  query ShopLocales {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

/**
 * GET /api/shopify/locales?shop=<domain>
 *
 * Returns all shopLocales for the store. Results are cached per shop for
 * 5 minutes (locales rarely change mid-session).
 *
 * Requires: read_locales scope.
 */
export async function GET(req: NextRequest) {
  const rawShop = req.nextUrl.searchParams.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(rawShop);

  if (!shop) {
    return NextResponse.json({ error: "Missing ?shop= parameter." }, { status: 400 });
  }

  // Serve from cache if fresh (skip when ?nocache=1 — used by hreflang Recheck)
  const nocache = req.nextUrl.searchParams.get("nocache") === "1";
  const cached = cache.get(shop);
  if (!nocache && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ shop, locales: cached.locales });
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
      { status: 401 }
    );
  }

  try {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: QUERY }),
    });

    const json = (await res.json()) as {
      data?: { shopLocales?: ShopLocale[] };
      errors?: { message: string }[];
    };

    const gqlErrors = Array.isArray(json.errors) ? json.errors : [];
    if (!res.ok || gqlErrors.length) {
      const msg = gqlErrors.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      const is401 = isShopify401(res.status, json);
      const isScopeError =
        msg.toLowerCase().includes("access denied") ||
        msg.toLowerCase().includes("scope") ||
        msg.toLowerCase().includes("read_locales");
      console.warn("[locales] Shopify error:", msg);
      if (is401) {
        await handleShopify401(shop);
        return NextResponse.json({
          shop, locales: [],
          error: "Token expired or revoked — please reconnect in Settings.",
        });
      }
      return NextResponse.json({
        shop,
        locales: [],
        error: isScopeError
          ? "read_locales scope missing — reconnect to grant access"
          : msg,
      });
    }

    const locales: ShopLocale[] = (json.data?.shopLocales ?? []).map((l) => ({
      locale: l.locale,
      name: l.name,
      primary: !!l.primary,
      published: l.published !== false,
    }));

    cache.set(shop, { locales, fetchedAt: Date.now() });
    return NextResponse.json({ shop, locales });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[locales]", msg);
    // Always return 200 so the UI receives JSON and can show a helpful message
    return NextResponse.json({ shop, locales: [], error: msg });
  }
}
