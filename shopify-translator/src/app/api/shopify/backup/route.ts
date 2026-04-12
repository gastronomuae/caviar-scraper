import { NextRequest, NextResponse } from "next/server";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { getBackup, deleteBackup } from "@/lib/server/shopifyBackupStore";

function parseParams(req: NextRequest): {
  shop: string;
  resourceId: string;
  locale: string;
  marketId?: string;
  error?: string;
} {
  const p = req.nextUrl.searchParams;
  const rawShop    = p.get("shop") ?? "";
  const resourceId = (p.get("resourceId") ?? "").trim();
  const locale     = (p.get("locale") ?? "").trim();
  const marketId   = p.get("marketId")?.trim() || undefined;
  const shop       = normalizeShopifyAdminDomain(rawShop);
  if (!shop || !resourceId || !locale) {
    return { shop, resourceId, locale, marketId, error: "Missing required params: shop, resourceId, locale" };
  }
  return { shop, resourceId, locale, marketId };
}

/**
 * GET /api/shopify/backup?shop=&resourceId=&locale=[&marketId=]
 * Returns the stored backup record or 404 if none exists.
 */
export async function GET(req: NextRequest) {
  const { shop, resourceId, locale, marketId, error } = parseParams(req);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const backup = await getBackup(shop, resourceId, locale, marketId);
  if (!backup) return NextResponse.json({ exists: false }, { status: 404 });
  return NextResponse.json({ exists: true, backup });
}

/**
 * DELETE /api/shopify/backup?shop=&resourceId=&locale=[&marketId=]
 * Removes the stored backup. Used to clear manually if needed.
 */
export async function DELETE(req: NextRequest) {
  const { shop, resourceId, locale, marketId, error } = parseParams(req);
  if (error) return NextResponse.json({ error }, { status: 400 });

  await deleteBackup(shop, resourceId, locale, marketId);
  return NextResponse.json({ ok: true });
}
