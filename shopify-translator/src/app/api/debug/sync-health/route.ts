import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

const API_VERSION = SHOPIFY_ADMIN_API_VERSION;

/**
 * Canonical 2025-07 TranslatableResourceType enum values to probe.
 * Confirmed valid on API 2025-07 (or no_records — valid enum, just no store data).
 *
 * Removed:
 *   ONLINE_STORE_PAGE / _ARTICLE / _BLOG — confirmed invalid (renamed to PAGE/ARTICLE/BLOG)
 *   SMS_TEMPLATE / SHOP_SMS_TEMPLATE     — both confirmed invalid on 2025-07
 *
 * Under investigation (theme sub-types discovered in 2025-07 docs):
 *   ONLINE_STORE_THEME_APP_EMBED, _JSON_TEMPLATE, _LOCALE_CONTENT,
 *   _SECTION_GROUP, _SETTINGS_CATEGORY, _SETTINGS_DATA_SECTIONS
 */
const ALL_SYNC_TYPES = [
  "PRODUCT",
  "COLLECTION",
  "METAFIELD",
  "METAOBJECT",
  "PAGE",
  "ARTICLE",
  "BLOG",
  "ONLINE_STORE_THEME",
  // Theme sub-types — probing validity on 2025-07 (may be ok, no_records, or enum_error)
  "ONLINE_STORE_THEME_APP_EMBED",
  "ONLINE_STORE_THEME_JSON_TEMPLATE",
  "ONLINE_STORE_THEME_LOCALE_CONTENT",
  "ONLINE_STORE_THEME_SECTION_GROUP",
  "ONLINE_STORE_THEME_SETTINGS_CATEGORY",
  "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS",
  "MENU",
  "LINK",
  "SHOP",
  "SHOP_POLICY",
  "DELIVERY_METHOD_DEFINITION",
  "EMAIL_TEMPLATE",
  "PAYMENT_GATEWAY",
  "PACKING_SLIP_TEMPLATE",
  "SELLING_PLAN",
  "SELLING_PLAN_GROUP",
  "FILTER",
  "PRODUCT_OPTION",
  "PRODUCT_OPTION_VALUE",
] as const;

type SyncType = (typeof ALL_SYNC_TYPES)[number];

type TypeResult =
  | {
      status: "ok";
      nodeCount: number;
      sampleResourceId: string | null;
      sampleKeys: string[];
    }
  | { status: "enum_error"; error: string }
  | { status: "http_error"; httpStatus: number; error: string }
  | { status: "no_records" };

/**
 * Probe a single TranslatableResourceType with first: 1.
 * Each type is probed in a separate request so an invalid enum on one type
 * never masks results for another.
 */
async function probeType(
  shop: string,
  token: string,
  resourceType: SyncType,
): Promise<TypeResult> {
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `{
          translatableResources(resourceType: ${resourceType}, first: 1) {
            nodes {
              resourceId
              translatableContent { key }
            }
          }
        }`,
      }),
    });
    rawText = await res.text();
  } catch (err) {
    return {
      status: "http_error",
      httpStatus: 0,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }

  if (!res.ok) {
    return { status: "http_error", httpStatus: res.status, error: rawText.slice(0, 300) };
  }

  let json: {
    data?: { translatableResources?: { nodes?: Array<{ resourceId: string; translatableContent: { key: string }[] }> } } | null;
    errors?: Array<{ message: string }>;
  };
  try {
    json = JSON.parse(rawText) as typeof json;
  } catch {
    return { status: "http_error", httpStatus: res.status, error: "Non-JSON response" };
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    return { status: "enum_error", error: msg };
  }

  const nodes = json.data?.translatableResources?.nodes ?? [];
  if (nodes.length === 0) {
    return { status: "no_records" };
  }

  const first = nodes[0];
  return {
    status: "ok",
    nodeCount: nodes.length,
    sampleResourceId: first.resourceId ?? null,
    sampleKeys: (first.translatableContent ?? []).map((c) => c.key),
  };
}

/**
 * Metafield owner type candidates to probe.
 * Baseline types (PRODUCT, COLLECTION, etc.) are already known-good and excluded here.
 * Results appear under metafieldOwnerTypes in the health report.
 */
const CANDIDATE_METAFIELD_OWNER_TYPES = [
  "COMPANY",
  "COMPANY_LOCATION",
  "CUSTOMER",
  "LOCATION",
  "MARKET",
  "ORDER",
] as const;
type MetafieldOwnerType = (typeof CANDIDATE_METAFIELD_OWNER_TYPES)[number];

type OwnerTypeResult =
  | { status: "supported"; defCount: number }
  | { status: "no_definitions" }
  | { status: "enum_error"; error: string }
  | { status: "http_error"; httpStatus: number; error: string };

async function probeMetafieldOwnerType(
  shop: string,
  token: string,
  ownerType: MetafieldOwnerType,
): Promise<OwnerTypeResult> {
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `query ProbeOwner($ownerType: MetafieldOwnerType!) {
          metafieldDefinitions(ownerType: $ownerType, first: 5) {
            nodes { namespace key name }
          }
        }`,
        variables: { ownerType },
      }),
    });
    rawText = await res.text();
  } catch (err) {
    return { status: "http_error", httpStatus: 0, error: err instanceof Error ? err.message : "fetch failed" };
  }

  if (!res.ok) {
    return { status: "http_error", httpStatus: res.status, error: rawText.slice(0, 300) };
  }

  let json: { data?: { metafieldDefinitions?: { nodes?: unknown[] } } | null; errors?: { message: string }[] };
  try {
    json = JSON.parse(rawText) as typeof json;
  } catch {
    return { status: "http_error", httpStatus: res.status, error: "Non-JSON response" };
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    return { status: "enum_error", error: msg };
  }

  const nodes = json.data?.metafieldDefinitions?.nodes ?? [];
  if (nodes.length === 0) return { status: "no_definitions" };
  return { status: "supported", defCount: nodes.length };
}

/**
 * GET /api/debug/sync-health?shop=<domain>
 *
 * Probes every resource type in SHOPIFY_SYNC_RESOURCE_TYPES independently
 * (one query per type) and returns a health report.
 * Also probes candidate MetafieldOwnerType values and reports results
 * under metafieldOwnerTypes.
 *
 * status meanings (translatableResources):
 *   ok          — type is supported and has translatable records in this store
 *   no_records  — type is a valid enum but has 0 records in this store
 *   enum_error  — type is not a valid TranslatableResourceType on this API version
 *   http_error  — network or auth problem (check httpStatus)
 *
 * status meanings (metafieldOwnerTypes):
 *   supported      — valid enum + at least 1 metafield definition exists
 *   no_definitions — valid enum, 0 definitions on this store (still usable)
 *   enum_error     — not a valid MetafieldOwnerType value on this API version
 *   http_error     — network or auth problem
 */
export async function GET(req: NextRequest) {
  const rawShop = req.nextUrl.searchParams.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(rawShop);

  if (!shop) {
    return NextResponse.json(
      { error: "Missing ?shop= parameter. Example: ?shop=my-store.myshopify.com" },
      { status: 400 },
    );
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

  const view = req.nextUrl.searchParams.get("view") ?? "full";
  if (view !== "full" && view !== "summary" && view !== "problems") {
    return NextResponse.json(
      { error: "Invalid ?view= value. Must be one of: full, summary, problems" },
      { status: 400 },
    );
  }

  const startMs = Date.now();

  // Run both probe sets concurrently.
  const [typeEntries, ownerEntries] = await Promise.all([
    // TranslatableResourceType probes
    Promise.all(
      ALL_SYNC_TYPES.map(async (type) => {
        const result = await probeType(shop, token, type);
        return [type, result] as [SyncType, TypeResult];
      }),
    ),
    // MetafieldOwnerType candidate probes
    Promise.all(
      CANDIDATE_METAFIELD_OWNER_TYPES.map(async (ot) => {
        const result = await probeMetafieldOwnerType(shop, token, ot);
        return [ot, result] as [MetafieldOwnerType, OwnerTypeResult];
      }),
    ),
  ]);

  const typeMap = Object.fromEntries(typeEntries) as Record<SyncType, TypeResult>;
  const ownerMap = Object.fromEntries(ownerEntries) as Record<MetafieldOwnerType, OwnerTypeResult>;

  const summary = { ok: 0, no_records: 0, enum_error: 0, http_error: 0 };
  for (const r of Object.values(typeMap)) {
    summary[r.status]++;
  }

  const ownerSummary = {
    supported: 0,
    no_definitions: 0,
    enum_error: 0,
    http_error: 0,
  };
  for (const r of Object.values(ownerMap)) {
    ownerSummary[r.status]++;
  }

  const elapsedMs = Date.now() - startMs;
  const base = { shop, apiVersion: API_VERSION, elapsedMs, summary, ownerSummary };

  if (view === "summary") {
    return NextResponse.json(base, { headers: { "Cache-Control": "no-store" } });
  }

  if (view === "problems") {
    const problemTypes = Object.fromEntries(
      Object.entries(typeMap).filter(([, r]) => r.status !== "ok"),
    );
    const problemOwners = Object.fromEntries(
      Object.entries(ownerMap).filter(([, r]) => r.status === "enum_error" || r.status === "http_error"),
    );
    return NextResponse.json(
      { ...base, types: problemTypes, metafieldOwnerTypes: problemOwners },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // view=full (default)
  return NextResponse.json(
    {
      ...base,
      probeCount: ALL_SYNC_TYPES.length,
      types: typeMap,
      metafieldOwnerTypes: ownerMap,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
