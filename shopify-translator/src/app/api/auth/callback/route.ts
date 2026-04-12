import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  debugTokenStoreKey,
  getStoredAccessToken,
  setStoredAccessToken,
  tokenCookieName,
  legacyTokenCookieNames,
} from "@/lib/server/shopifyTokenStore";
import { supabase } from "@/lib/supabaseClient";

/**
 * Verifies the HMAC Shopify attaches to every OAuth callback/webhook request.
 * Returns true when SHOPIFY_CLIENT_SECRET is not set (allows local dev without the var).
 */
function verifyShopifyHmac(params: URLSearchParams): boolean {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret) return true;

  const hmac = params.get("hmac") ?? "";
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

function tokenPreview(token: string | null | undefined): string {
  if (!token) return "(none)";
  return `${token.slice(0, 10)}...`;
}

/**
 * GET /api/auth/callback
 *
 * Shopify redirects here after the merchant approves the app installation.
 * Query params: code, shop, hmac, state, timestamp
 *
 * - Validates HMAC using SHOPIFY_CLIENT_SECRET env var
 * - Validates OAuth `state` matches `shopify_oauth_state` cookie (CSRF)
 * - Exchanges code for an access_token via Shopify
 * - Stores the token server-side (in-memory + file fallback)
 * - Redirects merchant to /settings?shopify_oauth=ok&shop=...
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");

  if (!shop || !code) {
    return new NextResponse("Missing shop or code parameter.", { status: 400 });
  }

  // Basic shop domain format guard
  if (!/^[a-zA-Z0-9-]+\.myshopify\.com$/.test(shop)) {
    return new NextResponse("Invalid shop domain.", { status: 400 });
  }

  if (!verifyShopifyHmac(searchParams)) {
    return new NextResponse("HMAC validation failed.", { status: 401 });
  }

  const queryState = searchParams.get("state");
  const cookieState = req.cookies.get("shopify_oauth_state")?.value;
  if (!queryState || !cookieState) {
    console.warn(
      "[auth/callback] OAuth state validation failed:",
      !queryState ? "missing query state" : "missing shopify_oauth_state cookie"
    );
    return new NextResponse("Invalid OAuth state", { status: 401 });
  }
  const bufQ = Buffer.from(queryState, "utf8");
  const bufC = Buffer.from(cookieState, "utf8");
  if (bufQ.length !== bufC.length || !crypto.timingSafeEqual(bufQ, bufC)) {
    console.warn("[auth/callback] OAuth state validation failed: query and cookie mismatch");
    return new NextResponse("Invalid OAuth state", { status: 401 });
  }
  console.log("[auth/callback] OAuth state validation succeeded");

  const clientId = process.env.SHOPIFY_API_KEY ?? "";
  const clientSecret = process.env.SHOPIFY_API_SECRET ?? "";

  if (!clientId || !clientSecret) {
    return new NextResponse(
      "SHOPIFY_API_KEY and SHOPIFY_API_SECRET environment variables are not set. " +
        "Add them to your Vercel project settings and redeploy.",
      { status: 500 }
    );
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error("[auth/callback] Token exchange failed:", tokenRes.status, body);
      return new NextResponse(`Shopify token exchange failed (${tokenRes.status}): ${body}`, {
        status: 502,
      });
    }

    const json = (await tokenRes.json()) as { access_token?: string; error?: string };

    if (!json.access_token) {
      console.error("[auth/callback] No access_token in Shopify response:", json);
      return new NextResponse("Shopify did not return an access token.", { status: 502 });
    }

    const before = await getStoredAccessToken(shop);
    const storageKey = debugTokenStoreKey(shop);
    console.log(
      `[auth/callback] Writing token for shop=${shop} key=${storageKey} oauth_token=${tokenPreview(json.access_token)}`
    );
    try {
      await setStoredAccessToken(shop, json.access_token, "oauth");
      console.log("[auth/callback] Write succeeded");
    } catch (err) {
      console.error("[auth/callback] Write FAILED:", err);
      return new NextResponse("OAuth token write failed.", { status: 500 });
    }
    const after = await getStoredAccessToken(shop);
    console.log(
      `[auth/callback] Token stored for ${shop}. before=${tokenPreview(before)} after=${tokenPreview(after)} changed=${before !== after}`
    );
    if (!after) {
      console.error(
        `[auth/callback] Token persisted as empty for shop=${shop} key=${storageKey} oauth_token=${tokenPreview(json.access_token)}`
      );
      return new NextResponse(
        "OAuth callback completed but token could not be persisted. Check server token storage configuration/logs.",
        { status: 500 }
      );
    }

    // Persist token to Supabase (non-blocking — failure must not abort OAuth flow).
    try {
      const { error: sbError } = await supabase
        .from("stores")
        .upsert({ shop_domain: shop, access_token: json.access_token });
      if (sbError) {
        console.warn("[auth/callback] Supabase upsert failed:", sbError.message);
      } else {
        console.log("[auth/callback] Supabase token stored for shop:", shop);
      }
    } catch (sbErr) {
      console.warn("[auth/callback] Supabase upsert threw:", sbErr instanceof Error ? sbErr.message : sbErr);
    }

    const apiKey = process.env.SHOPIFY_API_KEY ?? "";
    const appBase = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;

    // If a return_to cookie was set during auth/start, send the user back there.
    // Otherwise fall back to the Shopify admin embedded view.
    const returnTo = req.cookies.get("shopify_oauth_return_to")?.value ?? "";
    const dest = (returnTo.startsWith("/"))
      ? `${appBase}${returnTo}?shopify_oauth=ok&shop=${encodeURIComponent(shop)}`
      : `https://${shop}/admin/apps/${apiKey}`;
    const response = NextResponse.redirect(dest);

    const isProd = process.env.VERCEL_ENV === "production";
    response.cookies.set("shopify_oauth_state", "", {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      path: "/",
      maxAge: 0,
    });
    response.cookies.set("shopify_oauth_return_to", "", {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      path: "/",
      maxAge: 0,
    });

    // Persist token in a cookie so it survives Vercel cold starts.
    // SameSite=None + Secure is required for cookies inside Shopify's iframe.
    response.cookies.set(tokenCookieName(shop), json.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    });

    // Delete any legacy format cookies so stale tokens can't interfere.
    for (const legacyName of legacyTokenCookieNames(shop)) {
      response.cookies.set(legacyName, "", { maxAge: 0, path: "/" });
    }

    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[auth/callback] Unexpected error:", msg);
    return new NextResponse(`OAuth error: ${msg}`, { status: 500 });
  }
}
