import { NextRequest, NextResponse } from "next/server";
import {
  deleteStoredAccessToken,
  legacyTokenCookieNames,
  normalizeShopifyAdminDomain,
  tokenCookieName,
} from "@/lib/server/shopifyTokenStore";

/**
 * GET /api/auth/reinstall?shop=<domain>
 *
 * Clears any stored token for the shop, then redirects to /api/auth/start
 * to force a fresh Shopify OAuth install flow.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("shop") ?? "";
  const shop = normalizeShopifyAdminDomain(raw);

  if (!shop) {
    return new NextResponse("Missing shop parameter.", { status: 400 });
  }

  const base = new URL(req.url).origin;
  const response = NextResponse.redirect(`${base}/api/auth/start?shop=${encodeURIComponent(shop)}`);

  await deleteStoredAccessToken(shop);
  response.cookies.delete(tokenCookieName(shop));
  for (const legacyName of legacyTokenCookieNames(shop)) {
    response.cookies.set(legacyName, "", { maxAge: 0, path: "/" });
  }
  console.log(`[auth/reinstall] Cleared stored token + cookies (current + legacy) for ${shop}, redirecting to OAuth`);

  return response;
}
