import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";

export type ClientCredentialsExchangeResult =
  | {
      ok: true;
      cleanDomain: string;
      access_token: string;
      expires_in: number;
      scope: string;
      granted_scopes?: string[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      granted_scopes?: string[];
    };

/**
 * Custom app / dev: client_credentials grant against Shopify Admin OAuth endpoint.
 * Shared by POST /api/shopify/token and {@link resolveShopifyAccessToken}.
 */
export async function exchangeClientCredentialsToken(
  shopifyDomain: string,
  clientId: string,
  clientSecret: string
): Promise<ClientCredentialsExchangeResult> {
  const cleanDomain = normalizeShopifyAdminDomain(shopifyDomain);
  if (!cleanDomain || !clientId || !clientSecret) {
    return { ok: false, status: 400, error: "Missing domain, client id, or client secret." };
  }

  try {
    const res = await fetch(`https://${cleanDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const data = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
      scope?: string;
      expires_in?: number;
    };

    if (!res.ok) {
      const msg = data?.error_description ?? data?.error ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: 401,
          error:
            "Invalid credentials. Double-check your Client ID and Client Secret in Shopify Admin → Apps → Develop apps.",
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          status: 404,
          error: `Store not found: "${cleanDomain}". Make sure the domain is correct.`,
        };
      }
      return { ok: false, status: res.status, error: msg };
    }

    if (!data.access_token) {
      return {
        ok: false,
        status: 502,
        error: "Shopify returned a response but no access token. Make sure the app is installed on the store.",
      };
    }

    const token = data.access_token;

    let grantedScopes: string[] = [];
    try {
      const scopeRes = await fetch(`https://${cleanDomain}/admin/oauth/access_scopes.json`, {
        headers: { "X-Shopify-Access-Token": token },
      });
      if (scopeRes.ok) {
        const scopeJson = (await scopeRes.json()) as { access_scopes?: { handle: string }[] };
        grantedScopes = (scopeJson.access_scopes ?? []).map((s) => s.handle);
      }
    } catch {
      /* ignore */
    }

    const hasReadT = grantedScopes.includes("read_translations");
    const hasWriteT = grantedScopes.includes("write_translations");
    if (grantedScopes.length > 0 && (!hasReadT || !hasWriteT)) {
      return {
        ok: false,
        status: 422,
        error:
          "Token was issued but does NOT include read_translations + write_translations. " +
          "Fix: Shopify Admin → Develop apps → your app → Configuration → Admin API scopes → " +
          "enable read_translations and write_translations → Save → Reinstall app on this store → Connect again.",
        granted_scopes: grantedScopes,
      };
    }

    return {
      ok: true,
      cleanDomain,
      access_token: token,
      expires_in: data.expires_in ?? 86400,
      scope: data.scope ?? "",
      granted_scopes: grantedScopes.length ? grantedScopes : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, status: 500, error: `Network error: ${msg}` };
  }
}
