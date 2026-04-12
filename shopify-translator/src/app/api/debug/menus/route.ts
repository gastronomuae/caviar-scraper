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
): Promise<{ httpStatus: number; data: unknown; errors: unknown[] | null; rawText: string }> {
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
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
    rawText: rawText.slice(0, 1000),
  };
}

/**
 * GET /api/debug/menus?shop=<domain>
 *
 * Diagnoses menu sync access by running three independent probes:
 *   1. Navigation API — `menus(first: 5)` (requires read_online_store_navigation scope, API 2024-07+)
 *   2. Translations API — `translatableResources(MENU, first: 5)` (requires read_translations)
 *   3. Translations API — `translatableResources(LINK, first: 5)` (requires read_translations)
 *
 * Returns per-probe status, sample data, and a plain-English diagnosis.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const shop = normalizeShopifyAdminDomain(searchParams.get("shop") ?? "");

  if (!shop) {
    return NextResponse.json(
      { error: "Missing ?shop=<myshopify-domain> query parameter." },
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
      { error: `Token not found: ${err instanceof Error ? err.message : String(err)}` },
      { status: 401 },
    );
  }

  // ── Probe 1: Navigation API menus query ───────────────────────────────────
  const MENUS_QUERY = `
    query DebugMenus {
      menus(first: 5) {
        nodes {
          id
          handle
          title
          itemsCount: items {
            id
          }
        }
      }
    }
  `;

  // ── Probe 2: Translations API — MENU resources ────────────────────────────
  const TR_MENU_QUERY = `
    query DebugTrMenus($locale: String!) {
      translatableResources(resourceType: MENU, first: 5) {
        nodes {
          resourceId
          translatableContent { key value locale }
          translations(locale: $locale) { key value }
        }
      }
    }
  `;

  // ── Probe 3: Translations API — LINK resources (menu items) ──────────────
  const TR_LINK_QUERY = `
    query DebugTrLinks($locale: String!) {
      translatableResources(resourceType: LINK, first: 5) {
        nodes {
          resourceId
          translatableContent { key value locale }
          translations(locale: $locale) { key value }
        }
      }
    }
  `;

  // ── Probe 4: App scopes (for diagnosing missing read_content) ─────────────
  const SCOPES_QUERY = `{ appInstallation { accessScopes { handle } } }`;

  const locale = "en"; // target locale used in sample translations probe

  const [navResult, trMenuResult, trLinkResult, scopesResult] = await Promise.all([
    gql(shop, token, MENUS_QUERY),
    gql(shop, token, TR_MENU_QUERY, { locale }),
    gql(shop, token, TR_LINK_QUERY, { locale }),
    gql(shop, token, SCOPES_QUERY),
  ]);

  // ── Parse scopes ──────────────────────────────────────────────────────────
  const scopesData = scopesResult.data as { appInstallation?: { accessScopes?: { handle: string }[] } } | null;
  const scopes = (scopesData?.appInstallation?.accessScopes ?? []).map((s) => s.handle).sort();

  // ── Summarise navigation probe ────────────────────────────────────────────
  const navMenus = (navResult.data as { menus?: { nodes?: unknown[] } } | null)?.menus?.nodes ?? null;
  const navOk = navResult.httpStatus === 200 && !navResult.errors?.length && navMenus !== null;

  // ── Summarise translation probes ──────────────────────────────────────────
  type TrNode = { resourceId: string; translatableContent: unknown[]; translations: unknown[] };
  const trMenuNodes = (
    trMenuResult.data as { translatableResources?: { nodes?: TrNode[] } } | null
  )?.translatableResources?.nodes ?? null;
  const trLinkNodes = (
    trLinkResult.data as { translatableResources?: { nodes?: TrNode[] } } | null
  )?.translatableResources?.nodes ?? null;
  const trMenuOk = trMenuResult.httpStatus === 200 && !trMenuResult.errors?.length && trMenuNodes !== null;
  const trLinkOk = trLinkResult.httpStatus === 200 && !trLinkResult.errors?.length && trLinkNodes !== null;

  // ── Plain-English diagnosis ────────────────────────────────────────────────
  const issues: string[] = [];
  if (!scopes.includes("read_online_store_navigation")) {
    issues.push("⚠ read_online_store_navigation scope is MISSING — re-run OAuth to get a fresh token (required for Navigation API menus query)");
  }
  if (!scopes.includes("read_content")) {
    issues.push("⚠ read_content scope is MISSING — re-run OAuth to get a fresh token");
  }
  if (!scopes.includes("read_translations")) {
    issues.push("⚠ read_translations scope is MISSING — re-run OAuth");
  }
  if (!navOk) {
    const errMsg = navResult.errors?.[0]
      ? JSON.stringify(navResult.errors[0]).slice(0, 200)
      : `HTTP ${navResult.httpStatus}`;
    issues.push(`✗ Navigation API menus query failed: ${errMsg}`);
  }
  if (!trMenuOk) {
    const errMsg = trMenuResult.errors?.[0]
      ? JSON.stringify(trMenuResult.errors[0]).slice(0, 200)
      : `HTTP ${trMenuResult.httpStatus}`;
    issues.push(`✗ Translations API MENU query failed: ${errMsg}`);
  }
  if (!trLinkOk) {
    const errMsg = trLinkResult.errors?.[0]
      ? JSON.stringify(trLinkResult.errors[0]).slice(0, 200)
      : `HTTP ${trLinkResult.httpStatus}`;
    issues.push(`✗ Translations API LINK query failed: ${errMsg}`);
  }

  const result = {
    shop,
    apiVersion: API_VERSION,
    tokenPreview: `${token.slice(0, 12)}...`,
    diagnosis: issues.length === 0 ? "✅ All menu probes passed — menus should sync correctly" : issues,
    scopes: {
      total: scopes.length,
      has_read_online_store_navigation: scopes.includes("read_online_store_navigation"),
      has_read_content:      scopes.includes("read_content"),
      has_write_content:     scopes.includes("write_content"),
      has_read_translations: scopes.includes("read_translations"),
      all: scopes,
    },
    probes: {
      nav_menus: {
        description: "menus(first:5) — Navigation API (requires read_online_store_navigation, API 2024-07+)",
        ok: navOk,
        httpStatus: navResult.httpStatus,
        errors: navResult.errors,
        menuCount: navMenus?.length ?? null,
        sample: navMenus?.slice(0, 3),
      },
      translations_menu: {
        description: "translatableResources(MENU, first:5) — Translations API",
        ok: trMenuOk,
        httpStatus: trMenuResult.httpStatus,
        errors: trMenuResult.errors,
        nodeCount: trMenuNodes?.length ?? null,
        sample: trMenuNodes?.slice(0, 2),
      },
      translations_link: {
        description: "translatableResources(LINK, first:5) — Translations API (menu items)",
        ok: trLinkOk,
        httpStatus: trLinkResult.httpStatus,
        errors: trLinkResult.errors,
        nodeCount: trLinkNodes?.length ?? null,
        sample: trLinkNodes?.slice(0, 2),
      },
    },
  };

  console.log("[debug/menus]", JSON.stringify({ shop, diagnosis: result.diagnosis, scopes: result.scopes }, null, 2));
  return NextResponse.json(result);
}
