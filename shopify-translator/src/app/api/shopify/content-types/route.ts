import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

const API_VERSION = SHOPIFY_ADMIN_API_VERSION;
const TYPES_TO_PROBE = [
  // CONTENT — canonical 2025-07 enum values
  "PRODUCT",
  "COLLECTION",
  "PAGE",      // was ONLINE_STORE_PAGE
  "ARTICLE",   // was ONLINE_STORE_ARTICLE
  "BLOG",      // was ONLINE_STORE_BLOG
  "ONLINE_STORE_THEME",
  // STORE
  "MENU",
  "LINK",
  "SHOP",
  "SHOP_POLICY",
  "DELIVERY_METHOD_DEFINITION",
  "EMAIL_TEMPLATE",
  // SMS_TEMPLATE / SHOP_SMS_TEMPLATE both confirmed invalid on 2025-07 — removed
  "PAYMENT_GATEWAY",
  "PACKING_SLIP_TEMPLATE",
  "SELLING_PLAN",
  "SELLING_PLAN_GROUP",
  "FILTER",
  // METADATA
  "METAFIELD",
  "METAOBJECT",
] as const;

type ProbeType = (typeof TYPES_TO_PROBE)[number];

const probeCache = new Map<string, { types: ProbeType[]; detectedAt: string }>();

/**
 * GET /api/shopify/content-types?shop=<domain>
 *
 * Probes selected resource types one-by-one via `translatableResources(first: 1)`.
 * If a type has at least one record, it is included in `types`.
 * Results are cached in server memory per shop for the current runtime session.
 */
export async function GET(req: NextRequest) {
  const rawShop = req.nextUrl.searchParams.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(rawShop);

  if (!shop) {
    return NextResponse.json(
      { error: "Missing ?shop= parameter." },
      { status: 400 }
    );
  }

  // ?bust=true clears the in-memory cache so a fresh probe is forced.
  const bust = req.nextUrl.searchParams.get("bust") === "true";
  if (bust) probeCache.delete(shop);

  const cached = probeCache.get(shop);
  if (cached) {
    return NextResponse.json({
      shop,
      types: cached.types,
      source: "probe-cache",
      detectedAt: cached.detectedAt,
    });
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
    const detected: ProbeType[] = [];

    for (const type of TYPES_TO_PROBE) {
      const probeQuery = `{
        translatableResources(resourceType: ${type}, first: 1) {
          nodes { resourceId }
        }
      }`;

      const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query: probeQuery }),
      });

      if (!res.ok) {
        throw new Error(`Shopify API responded with HTTP ${res.status} while probing ${type}`);
      }

      const json = (await res.json()) as {
        data?: {
          translatableResources?: {
            nodes?: Array<{ resourceId?: string | null }>;
          };
        };
        errors?: { message: string }[];
      };

      if (json.errors?.length) {
        // Keep detection resilient: skip inaccessible types and continue.
        console.warn(
          `[content-types] probe skipped for ${type}:`,
          json.errors.map((e) => e.message).join("; ")
        );
        continue;
      }

      if ((json.data?.translatableResources?.nodes?.length ?? 0) > 0) {
        detected.push(type);
      }
    }

    const detectedAt = new Date().toISOString();
    probeCache.set(shop, { types: detected, detectedAt });

    return NextResponse.json({
      shop,
      types: detected,
      source: "probe-translatableResources",
      detectedAt,
    });
  } catch (err) {
    console.error("[content-types] type probe failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
