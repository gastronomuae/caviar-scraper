import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken, handleShopify401 } from "@/lib/server/resolveShopifyAccessToken";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";
import { logAppEvent } from "@/lib/server/appEventLogger";
import { pushSingleResource, createPushStats } from "@/lib/server/shopifyPush";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── GID builder ───────────────────────────────────────────────────────────
// The Translate & Adapt CSV stores Identification as a bare numeric ID (sometimes
// prefixed with a ' to prevent Excel from truncating large numbers).
// Shopify's GraphQL API requires a full GID: gid://shopify/Product/123456
const TYPE_TO_GID: Record<string, string> = {
  PRODUCT:                    "Product",
  PRODUCT_OPTION:             "ProductOption",
  PRODUCT_OPTION_VALUE:       "ProductOptionValue",
  COLLECTION:                 "Collection",
  ARTICLE:                    "Article",
  ARTICLE_IMAGE:              "MediaImage",
  MEDIA_IMAGE:                "MediaImage",
  BLOG:                       "Blog",
  PAGE:                       "Page",
  SHOP:                       "Shop",
  SHOP_POLICY:                "ShopPolicy",
  METAFIELD:                  "Metafield",
  // Shopify GIDs use gid://shopify/Metaobject/XXX (lowercase 'o')
  METAOBJECT:                 "Metaobject",
  EMAIL_TEMPLATE:             "EmailTemplate",
  FILTER:                     "Filter",
  MENU:                       "Menu",
  LINK:                       "Link",   // individual navigation links (menu items)
  ONLINE_STORE_MENU:          "Menu",
  ONLINE_STORE_THEME:         "OnlineStoreTheme",
  PACKING_SLIP_TEMPLATE:      "PackingSlipTemplate",
  PAYMENT_GATEWAY:            "PaymentGateway",
  DELIVERY_METHOD_DEFINITION: "DeliveryMethodDefinition",
};

function buildGid(type: string, identification: string): string {
  // Already a GID — return as-is
  if (identification.startsWith("gid://")) return identification;
  // Strip leading apostrophe (Excel CSV artifact) and whitespace
  const numericId = identification.replace(/^'+/, "").trim();
  const gidType = TYPE_TO_GID[type.toUpperCase()] ?? type;
  return `gid://shopify/${gidType}/${numericId}`;
}

// ── Types ──────────────────────────────────────────────────────────────────
interface PushField {
  key: string;       // e.g. "title", "body_html", "meta_title", "meta_description"
  value: string;     // the translated English content
}

interface PushRequest {
  shopifyDomain: string;
  /** Legacy fields kept for backward compatibility; OAuth token is required. */
  shopifyClientId?: string;
  shopifyClientSecret?: string;
  resourceId: string;
  resourceType: string;
  locale: string;
  fields: PushField[];
  /** When present, backup is stored per market so it can be restored per market. */
  marketId?: string;
}

/**
 * Shopify's translatableContent returns meta_title / meta_description directly —
 * no remapping needed. Keeping this function as a no-op in case future keys need mapping.
 */
function toShopifyTranslatableKey(internalKey: string): string {
  return internalKey;
}

// ── Shopify GraphQL helper ─────────────────────────────────────────────────
async function shopifyGql(domain: string, token: string, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const gqlErrors = Array.isArray(json.errors) ? json.errors : [];
  if (gqlErrors.length) {
    throw new Error(`Shopify GraphQL error: ${gqlErrors[0].message}`);
  }
  return json.data;
}

const DIGEST_QUERY = `
  query GetTranslatableContent($resourceId: ID!) {
    translatableResource(resourceId: $resourceId) {
      translatableContent {
        key
        value
        digest
        locale
      }
    }
  }
`;

// ── Step 1: Fetch content digests for the resource ────────────────────────
// Shopify requires a SHA256 digest of the original content per field.
// We fetch these from translatableResource before registering translations.
// Retries up to 3 times on THROTTLED to handle concurrent push bursts.
async function fetchDigests(
  domain: string,
  token: string,
  resourceId: string,
  locale: string,
  fieldKeys: string[]
): Promise<Map<string, string>> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await shopifyGql(domain, token, DIGEST_QUERY, { resourceId });

      const content: Array<{ key: string; value: string; digest: string; locale: string }> =
        data?.translatableResource?.translatableContent ?? [];

      console.log(`[push/shopify-keys] resourceId=${resourceId} keys=${content.map((c) => c.key).join(", ") || "(none)"}`);

      const digestMap = new Map<string, string>();
      for (const item of content) {
        if (fieldKeys.includes(item.key)) {
          digestMap.set(item.key, item.digest);
        }
      }

      void locale;
      return digestMap;
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : "";
      if (attempt < 2 && msg.includes("Throttled")) {
        const backoffMs = (attempt + 1) * 2000;
        console.warn(`[push/fetchDigests] THROTTLED on attempt ${attempt + 1} for ${resourceId}, backing off ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }
      throw e;
    }
  }

  throw lastError;
}

// ── Route handler ──────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // Absolute-first log — fires before any async work so concurrent requests are traceable
  console.log("[push/start]");

  let body: PushRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Log raw incoming type + id immediately after parse, before buildGid or any validation
  console.log(`[push/incoming] resourceType=${body.resourceType ?? "(missing)"} resourceId=${body.resourceId ?? "(missing)"}`);

  const { locale, fields } = body;
  for (const f of fields ?? []) {
    console.log(`[push/input-key] ${f.key}`);
  }
  const resourceId = buildGid(body.resourceType ?? "", body.resourceId ?? "");
  console.log(`[push/gid] ${resourceId}`);

  const cleanDomain = (body.shopifyDomain ?? "")
    .replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
  const shopifyDomain = cleanDomain.includes(".myshopify.com")
    ? cleanDomain
    : `${cleanDomain}.myshopify.com`;

  if (!shopifyDomain) {
    return NextResponse.json(
      { error: "Missing shopifyDomain. Connect in Settings first." },
      { status: 400 }
    );
  }
  if (!resourceId || !locale || !fields?.length) {
    return NextResponse.json({ error: "Missing resourceId, locale, or fields" }, { status: 400 });
  }

  let shopifyToken: string;
  try {
    const resolved = await resolveShopifyAccessToken({
      shopifyDomain,
      shopifyClientId: body.shopifyClientId,
      shopifyClientSecret: body.shopifyClientSecret,
      cookieHeader: req.headers.get("cookie"),
    });
    shopifyToken = resolved.token;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not resolve Shopify token";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  try {
    // Step 1: Get content digests (Shopify keys, e.g. seo.title — not meta_title)
    const fieldKeys = [...new Set(fields.map((f) => toShopifyTranslatableKey(f.key)))];
    let digestMap: Map<string, string>;
    try {
      digestMap = await fetchDigests(shopifyDomain, shopifyToken, resourceId, locale, fieldKeys);
    } catch (fetchErr) {
      console.error(`[push/fetchDigests error] resourceId=${resourceId} type=${body.resourceType}`, fetchErr);
      throw fetchErr;
    }

    // Step 2: Build translation inputs — skip fields with no digest (field not found in Shopify)
    const translations = fields
      .filter((f) => {
        const shopifyKey = toShopifyTranslatableKey(f.key);
        return digestMap.has(shopifyKey) && f.value.trim();
      })
      .map((f) => {
        const shopifyKey = toShopifyTranslatableKey(f.key);
        console.log(`[push/key-map] originalKey=${f.key} mappedKey=${shopifyKey}`);
        return {
          locale,
          key: shopifyKey,
          value: f.value,
          translatableContentDigest: digestMap.get(shopifyKey)!,
        };
      });

    for (const t of translations) {
      const orig = fields.find((f) => toShopifyTranslatableKey(f.key) === t.key)?.key ?? t.key;
      console.log(`[push/final-key] ${orig} → ${t.key}`);
    }

    if (translations.length === 0) {
      return NextResponse.json(
        { error: "None of the provided fields matched translatable content in Shopify. Check that the product exists and the field names are correct." },
        { status: 422 }
      );
    }

    // Step 3: Register translations (throttle-aware, retries on THROTTLED)
    console.log(`[push/register-input] resourceId=${resourceId} keys=${translations.map((t) => t.key).join(", ")} locale=${locale}`);
    const pushResult = await pushSingleResource(
      shopifyDomain,
      shopifyToken,
      resourceId,
      translations,
      { stats: createPushStats(), batchIndex: 0, tag: "push/single" },
    );

    if (pushResult.userErrors.length > 0) {
      const errMsg = pushResult.userErrors[0].message;
      logAppEvent({
        shop_domain: shopifyDomain,
        action:      "push_error",
        status:      "error",
        message:     `Shopify rejected translation: ${errMsg}`,
        metadata:    { resourceId, locale, userErrors: pushResult.userErrors },
      });
      return NextResponse.json(
        { error: `Shopify rejected the translation: ${errMsg}` },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      pushed: pushResult.pushed,
      fields: pushResult.fields,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[push/error] resourceId=${resourceId} type=${body.resourceType} error=${msg}`, err);
    const is401 = msg.includes("401") || msg.toLowerCase().includes("invalid api key");
    if (is401) { void handleShopify401(shopifyDomain); }
    logAppEvent({
      shop_domain: shopifyDomain,
      action:      "push_error",
      status:      "error",
      message:     `Push failed: ${msg}`,
      metadata:    { resourceId, locale },
    });
    if (is401) {
      return NextResponse.json(
        { error: "Token expired or revoked — please reconnect in Settings." },
        { status: 401 }
      );
    }
    if (msg.includes("read_translations") || msg.includes("write_translations")) {
      return NextResponse.json(
        {
          error:
            `${msg} — Re-connect in Settings (Connect to Shopify) after reinstalling the app with both translation scopes.`,
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
