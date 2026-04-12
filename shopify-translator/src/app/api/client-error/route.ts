import { NextRequest, NextResponse } from "next/server";
import { logAppEvent, type EventAction } from "@/lib/server/appEventLogger";

export interface ClientErrorPayload {
  shop?: string;
  action: string;
  message: string;
  url?: string;
  userAgent?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ClientErrorPayload;
    const shop = body.shop?.trim() || "unknown";
    const message = (body.message ?? "").slice(0, 500);
    const action = (body.action ?? "client_error") as EventAction;

    // Always log to Vercel stdout — immediately visible in `vercel logs`
    console.error(
      `[client-error] shop=${shop} action=${action} url=${body.url ?? "?"} ua=${(body.userAgent ?? "").slice(0, 80)} message=${message}`
    );

    // Also persist to Supabase logs table if configured
    logAppEvent({
      shop_domain: shop,
      action,
      status: "error",
      message,
      metadata: {
        url: body.url,
        userAgent: body.userAgent,
        source: "client",
      },
    });
  } catch {
    // never crash on a logging endpoint
  }

  return NextResponse.json({ ok: true });
}
