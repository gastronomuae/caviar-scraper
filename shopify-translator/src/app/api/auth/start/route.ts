import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * GET /api/auth/start?shop=<myshopify-domain>
 *
 * Initiates the Shopify OAuth flow using server-side env vars.
 * The frontend never needs to know the Client ID — just call this endpoint.
 *
 * Used by:
 * - page.tsx when shop param is present but no token is stored
 * - The "Connect with Shopify" button in Settings (as an alternative to the old flow)
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawShop = searchParams.get("shop") ?? "";
  const returnTo = searchParams.get("return_to") ?? "";

  const shop = rawShop.includes(".myshopify.com")
    ? rawShop.trim()
    : `${rawShop.trim()}.myshopify.com`;

  if (!shop || shop === ".myshopify.com") {
    return new NextResponse("Missing or invalid shop parameter.", { status: 400 });
  }

  const clientId = process.env.SHOPIFY_API_KEY ?? "";
  if (!clientId) {
    return new NextResponse(
      "SHOPIFY_API_KEY environment variable is not set. Add it to your Vercel project settings.",
      { status: 500 }
    );
  }

  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const redirectUri = `${appBase}/api/auth/callback`;
  // Canonical scope list — defined in code so a stale SHOPIFY_SCOPES env var can't omit required scopes.
  const scopes = [
    "read_products",
    "write_translations",
    "read_translations",
    "read_content",
    "write_content",
    "read_online_store_pages",
    "read_online_store_navigation",
    "read_themes",
    "read_metaobjects",
    "write_metaobjects",
    "read_locales",
    "write_locales",
    "read_legal_policies",
  ].join(",");
  const state = crypto.randomUUID();

  const authParams = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state,
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?${authParams.toString()}`;

  const isProd = process.env.VERCEL_ENV === "production";
  const response = NextResponse.redirect(authUrl);
  response.cookies.set("shopify_oauth_state", state, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    maxAge: 300,
  });

  // Preserve return path so the callback can redirect back after OAuth.
  // Only accept relative paths to prevent open-redirect attacks.
  if (returnTo.startsWith("/")) {
    response.cookies.set("shopify_oauth_return_to", returnTo, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      path: "/",
      maxAge: 300,
    });
  }

  return response;
}
