import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken, isShopify401, handleShopify401 } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

const API_VERSION = SHOPIFY_ADMIN_API_VERSION;

const QUERY = `#graphql
  query ShopPrimaryLocale {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

/**
 * GET /api/shopify/primary-locale?shop=<domain>
 *
 * Returns the store's primary locale from Admin GraphQL `shopLocales`
 * (OAuth token required).
 */
export async function GET(req: NextRequest) {
  const rawShop = req.nextUrl.searchParams.get("shop") ?? "";
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
      data?: {
        shopLocales?: Array<{
          locale?: string | null;
          name?: string | null;
          primary?: boolean | null;
          published?: boolean | null;
        }>;
      };
      errors?: { message: string }[];
    };

    const gqlErrors = Array.isArray(json.errors) ? json.errors : [];
    if (res.ok && !gqlErrors.length) {
      const locales = json.data?.shopLocales ?? [];
      const primary =
        locales.find((l) => l.primary) ??
        locales.find((l) => l.published !== false) ??
        locales[0];

      if (primary?.locale) {
        return NextResponse.json({
          shop,
          primaryLocale: primary.locale,
          primaryLocaleName: primary.name ?? primary.locale,
        });
      }
    }

    // Check for 401 on the GraphQL call before falling back to REST
    if (isShopify401(res.status, json)) {
      await handleShopify401(shop);
      return NextResponse.json(
        { error: "Token expired or revoked — please reconnect in Settings." },
        { status: 401 }
      );
    }

    // Fallback: REST shop (works when GraphQL `shopLocales` is unavailable or scope missing).
    const restRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/shop.json`, {
      headers: { "X-Shopify-Access-Token": token },
    });
    const restJson = (await restRes.json()) as { shop?: { primary_locale?: string | null } };

    if (isShopify401(restRes.status, restJson)) {
      await handleShopify401(shop);
      return NextResponse.json(
        { error: "Token expired or revoked — please reconnect in Settings." },
        { status: 401 }
      );
    }

    const code = restJson.shop?.primary_locale?.trim();
    if (restRes.ok && code) {
      return NextResponse.json({
        shop,
        primaryLocale: code,
        primaryLocaleName: null,
      });
    }

    const gqlErr = gqlErrors.map((e) => e.message).join("; ");
    return NextResponse.json(
      {
        error:
          gqlErr ||
          (restRes.ok ? "Could not read primary locale from Shopify." : `Shopify HTTP ${restRes.status}`),
      },
      { status: gqlErr || !restRes.ok ? 502 : 404 }
    );
  } catch (e) {
    console.error("[primary-locale]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
