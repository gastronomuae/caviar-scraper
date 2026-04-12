import { NextRequest, NextResponse } from "next/server";
import { pushTranslations } from "@/lib/shopifySyncEngine";
import { SyncedField } from "@/types";

export async function POST(req: NextRequest) {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    return NextResponse.json(
      { error: "Shopify credentials not configured" },
      { status: 503 }
    );
  }

  let resourceId: string;
  let locale: string;
  let fields: SyncedField[];

  try {
    const body = await req.json();
    resourceId = body.resourceId ?? "";
    locale =
      body.locale ?? process.env.SHOPIFY_TARGET_LOCALE ?? "en";
    fields = Array.isArray(body.fields) ? body.fields : [];
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!resourceId) {
    return NextResponse.json({ error: "resourceId is required" }, { status: 400 });
  }

  const toSend = fields.filter((f) => f.translatedValue?.trim());
  if (!toSend.length) {
    return NextResponse.json(
      { error: "No translated fields to push (all translatedValue are empty)" },
      { status: 400 }
    );
  }

  try {
    const result = await pushTranslations(
      shopDomain,
      accessToken,
      resourceId,
      locale,
      toSend
    );

    if (!result.success) {
      return NextResponse.json(
        { error: "translationsRegister returned errors", details: result.errors },
        { status: 422 }
      );
    }

    return NextResponse.json({ success: true, pushed: toSend.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Push failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
