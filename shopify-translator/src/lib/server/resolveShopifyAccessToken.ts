import {
  resolveToken,
  normalizeShopifyAdminDomain,
  deleteStoredAccessToken,
} from "@/lib/server/shopifyTokenStore";

export type ShopifyTokenSource = "oauth_store";

export type ResolveShopifyAccessTokenInput = {
  shopifyDomain: string;
  /** Legacy fields kept for backward compatibility; no longer used. */
  shopifyClientId?: string;
  shopifyClientSecret?: string;
  /** Cookie header from the incoming request — used as fallback after Vercel cold starts. */
  cookieHeader?: string | null;
};

function tokenPreview(token: string): string {
  return token.slice(0, 10);
}

/**
 * Resolves Admin API access token from OAuth-only server storage/cookie.
 * Client-credentials fallback is intentionally disabled for public-app flow safety.
 */
export async function resolveShopifyAccessToken(
  input: ResolveShopifyAccessTokenInput
): Promise<{ token: string; source: ShopifyTokenSource }> {
  const domain = normalizeShopifyAdminDomain(input.shopifyDomain);
  if (!domain) {
    throw new Error("Missing or invalid shopifyDomain.");
  }

  const stored = await resolveToken(domain, input.cookieHeader);
  if (stored) {
    console.info(`[token/resolve] resolved shop=${domain} token=${tokenPreview(stored)}... cookie_provided=${!!input.cookieHeader}`);
    return { token: stored, source: "oauth_store" };
  }

  throw new Error(
    'No OAuth token on the server for this store. Reconnect via "Connect with Shopify (OAuth)".'
  );
}

/**
 * Returns true when a Shopify API response indicates an invalid/expired token (401).
 * Shopify returns `errors` as a plain string on auth failures, not an array.
 */
export function isShopify401(status: number, body: unknown): boolean {
  if (status === 401) return true;
  if (typeof body === "object" && body !== null) {
    const err = (body as Record<string, unknown>).errors;
    if (typeof err === "string" && err.toLowerCase().includes("invalid api key")) return true;
  }
  return false;
}

/**
 * Call when a Shopify API call returns 401. Purges the stale token so the next
 * page load triggers a fresh OAuth flow instead of retrying with a dead token.
 */
export async function handleShopify401(shopDomain: string): Promise<void> {
  const domain = normalizeShopifyAdminDomain(shopDomain);
  if (!domain) return;
  try {
    await deleteStoredAccessToken(domain);
    console.warn(`[token/resolve] Purged stale token for ${domain} after Shopify 401`);
  } catch (err) {
    console.warn(`[token/resolve] Failed to purge token for ${domain}:`, err);
  }
}
