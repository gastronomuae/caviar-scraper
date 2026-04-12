import { NextRequest, NextResponse } from "next/server";
import {
  findProductIdByHandle,
  fetchProductSyncedFields,
} from "@/lib/shopifySyncEngine";

export async function POST(req: NextRequest) {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    return NextResponse.json(
      {
        error:
          "Shopify credentials not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN.",
      },
      { status: 503 }
    );
  }

  let handle: string;
  let resourceId: string | undefined;

  try {
    const body = await req.json();
    handle = (body.handle ?? "").trim();
    resourceId = body.resourceId ?? undefined;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!handle && !resourceId) {
    return NextResponse.json(
      { error: "Provide either handle or resourceId" },
      { status: 400 }
    );
  }

  try {
    // Resolve handle → GID when we don't already have it
    const shopifyId =
      resourceId ?? (await findProductIdByHandle(shopDomain, accessToken, handle));

    if (!shopifyId) {
      return NextResponse.json(
        { error: `Product not found in Shopify: "${handle}"` },
        { status: 404 }
      );
    }

    const { fields, imageUrlMap } = await fetchProductSyncedFields(
      shopDomain,
      accessToken,
      shopifyId
    );

    return NextResponse.json({ shopifyId, fields, imageUrlMap });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
