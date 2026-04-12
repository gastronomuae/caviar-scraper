import { NextRequest, NextResponse } from "next/server";
import { resolveShopifyAccessToken } from "@/lib/server/resolveShopifyAccessToken";
import {
  normalizeShopifyAdminDomain,
  tokenCookieName,
  legacyTokenCookieNames,
} from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

// Must match what the sync engine uses — both are tested here.
const API_VERSION = SHOPIFY_ADMIN_API_VERSION;
// Also tested with a known-older version to rule out API version as the cause.
const OLDER_API_VERSION = "2024-01";

async function gqlRaw(
  shop: string,
  token: string,
  apiVersion: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<{ httpStatus: number; data: unknown; errors: unknown[] | null; rawText: string }> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const rawText = await res.text();
  let parsed: { data?: unknown; errors?: unknown[] } = {};
  try { parsed = JSON.parse(rawText) as typeof parsed; } catch { /* non-JSON */ }
  return {
    httpStatus: res.status,
    data: parsed.data ?? null,
    errors: parsed.errors ?? null,
    rawText: rawText.slice(0, 500),
  };
}

/**
 * GET /api/debug/scopes?shop=<domain>
 *
 * Queries Shopify's `appInstallation { accessScopes }` to show exactly which
 * scopes the current OAuth token has been granted at runtime.
 *
 * Use this to verify whether `read_metaobjects` (and others) are present after
 * re-authorising. If a scope is missing here it was not granted — re-run OAuth.
 *
 * Remove or gate behind an env-var check before a public production launch.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawShop = searchParams.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(rawShop);

  if (!shop) {
    return NextResponse.json(
      { error: "Missing ?shop=<myshopify-domain> query parameter." },
      { status: 400 }
    );
  }

  // ── Cookie / storage diagnostics (always returned, even on failure) ──────
  const cookieHeader = req.headers.get("cookie") ?? "";
  const expectedCookieName = tokenCookieName(shop);
  const cookieNames = cookieHeader
    .split(";")
    .map((c) => c.trim().split("=")[0])
    .filter(Boolean);
  const hasExpectedCookie = cookieNames.includes(expectedCookieName);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "(not set)";
  const requestOrigin = new URL(req.url).origin;

  const legacyNames = legacyTokenCookieNames(shop);
  const legacyCookiesPresent = legacyNames.filter((n) => cookieNames.includes(n));

  const diagnostics = {
    shop,
    expectedCookieName,
    hasExpectedCookie,
    legacyCookieNames: legacyNames,
    legacyCookiesPresent,
    legacyCookieWarning:
      legacyCookiesPresent.length > 0
        ? `⚠ Found ${legacyCookiesPresent.length} legacy cookie(s): [${legacyCookiesPresent.join(", ")}]. These will be cleared on the next OAuth callback. If sync uses a stale token, run OAuth again to clear them.`
        : "✓ No legacy cookies.",
    cookiesPresent: cookieNames,
    appUrl_env: appUrl,
    requestOrigin,
    note: appUrl !== requestOrigin
      ? `⚠ Domain mismatch: OAuth callback sets cookie on "${appUrl}" but this request came from "${requestOrigin}". Hit the debug URL on the same domain that handles OAuth.`
      : "✓ Origins match.",
  };

  let token: string;
  try {
    const resolved = await resolveShopifyAccessToken({
      shopifyDomain: shop,
      cookieHeader,
    });
    token = resolved.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[debug/scopes] Token resolve failed for ${shop}:`, msg);
    return NextResponse.json({ error: `Token not found: ${msg}`, diagnostics }, { status: 401 });
  }

  const SCOPES_QUERY = `{ appInstallation { accessScopes { handle } } }`;
  const MO_DEF_MINIMAL = `{ metaobjectDefinitions(first: 1) { nodes { type } } }`;
  const MO_DEF_WITH_CAPS = `{
    metaobjectDefinitions(first: 3) {
      nodes {
        type
        name
        capabilities { translatable { enabled } }
      }
    }
  }`;

  try {
    // Run all probes in parallel: scopes + metaobjectDefinitions (current version + older version).
    const [scopesResult, moMinCurrent, moCapsCurrent, moMinOlder] = await Promise.all([
      gqlRaw(shop, token, API_VERSION, SCOPES_QUERY),
      gqlRaw(shop, token, API_VERSION, MO_DEF_MINIMAL),
      gqlRaw(shop, token, API_VERSION, MO_DEF_WITH_CAPS),
      gqlRaw(shop, token, OLDER_API_VERSION, MO_DEF_MINIMAL),
    ]);

    // Parse scopes
    const scopesData = scopesResult.data as { appInstallation?: { accessScopes?: { handle: string }[] } } | null;
    const handles = (scopesData?.appInstallation?.accessScopes ?? []).map((s) => s.handle).sort();

    const summary = {
      shop,
      tokenPreview: `${token.slice(0, 10)}...`,
      apiVersion: API_VERSION,
      scopeCount: handles.length,
      scopes: handles,
      checks: {
        read_metaobjects:  handles.includes("read_metaobjects"),
        write_metaobjects: handles.includes("write_metaobjects"),
        read_translations: handles.includes("read_translations"),
      },
      metaobjectDefinitionsProbe: {
        // Minimal query — just { type } — with current API version
        minimal_current: {
          apiVersion: API_VERSION,
          url: `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
          httpStatus: moMinCurrent.httpStatus,
          data: moMinCurrent.data,
          errors: moMinCurrent.errors,
        },
        // Full query with capabilities.translatable — current API version
        withCapabilities_current: {
          apiVersion: API_VERSION,
          httpStatus: moCapsCurrent.httpStatus,
          data: moCapsCurrent.data,
          errors: moCapsCurrent.errors,
        },
        // Minimal query — older API version (rules out version issue)
        minimal_older: {
          apiVersion: OLDER_API_VERSION,
          httpStatus: moMinOlder.httpStatus,
          data: moMinOlder.data,
          errors: moMinOlder.errors,
        },
      },
      diagnostics,
    };

    console.log("[debug/scopes]", JSON.stringify(summary, null, 2));
    return NextResponse.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[debug/scopes] probe failed:", msg);
    return NextResponse.json({ error: `Probe failed: ${msg}` }, { status: 502 });
  }
}
