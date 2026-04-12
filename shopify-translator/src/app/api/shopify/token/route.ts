import { NextRequest, NextResponse } from "next/server";

/** Disabled in OAuth-only mode to prevent storing legacy client-credentials tokens. */
export async function POST(req: NextRequest) {
  void req;
  return NextResponse.json(
    {
      error:
        "Client-credentials token exchange is disabled. Use Connect with Shopify (OAuth) to store a valid OAuth token.",
    },
    { status: 410 }
  );
}
