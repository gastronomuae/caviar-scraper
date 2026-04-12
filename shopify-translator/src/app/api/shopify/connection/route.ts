import { NextRequest, NextResponse } from "next/server";
import {
  deleteStoredAccessToken,
  hasStoredAccessToken,
  normalizeShopifyAdminDomain,
} from "@/lib/server/shopifyTokenStore";

/**
 * GET  ?domain= — whether a server-stored token exists for the shop.
 * DELETE ?domain= — remove stored token (disconnect).
 */
export async function GET(req: NextRequest) {
  const domain = normalizeShopifyAdminDomain(req.nextUrl.searchParams.get("domain") ?? "");
  if (!domain) {
    return NextResponse.json({ error: "Missing domain query parameter" }, { status: 400 });
  }
  return NextResponse.json({ connected: await hasStoredAccessToken(domain) });
}

export async function DELETE(req: NextRequest) {
  const domain = normalizeShopifyAdminDomain(req.nextUrl.searchParams.get("domain") ?? "");
  if (!domain) {
    return NextResponse.json({ error: "Missing domain query parameter" }, { status: 400 });
  }
  await deleteStoredAccessToken(domain);
  return NextResponse.json({ ok: true });
}
