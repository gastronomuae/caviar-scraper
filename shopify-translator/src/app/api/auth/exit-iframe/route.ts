import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/auth/exit-iframe?shop=<domain>
 *
 * When the app is embedded in Shopify admin (iframe) and needs to run OAuth,
 * it cannot redirect within the iframe — the redirect must happen at the
 * top-level (parent) frame.
 *
 * This endpoint returns an HTML page that uses Shopify App Bridge to perform
 * a top-level redirect to /api/auth/start, breaking out of the iframe.
 */
export async function GET(req: NextRequest) {
  const shop = req.nextUrl.searchParams.get("shop") ?? "";
  const returnTo = req.nextUrl.searchParams.get("return_to") ?? "";
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const startParams = new URLSearchParams({ shop });
  if (returnTo.startsWith("/")) startParams.set("return_to", returnTo);
  const authUrl = `${appBase}/api/auth/start?${startParams.toString()}`;

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Connecting to Shopify</title>
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #f6f6f7;
        color: #202223;
      }
      .card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
        background: #fff;
        border-radius: 12px;
        padding: 48px 56px;
        box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.06);
        text-align: center;
        max-width: 360px;
        width: 90%;
      }
      /* Polaris-style spinner */
      .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid #e3e3e3;
        border-top-color: #008060;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .title {
        font-size: 17px;
        font-weight: 600;
        color: #202223;
        letter-spacing: -0.01em;
      }
      .subtitle {
        font-size: 14px;
        color: #6d7175;
        line-height: 1.5;
      }
      .helper {
        font-size: 12px;
        color: #9ca3af;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="spinner"></div>
      <div>
        <p class="title">Connecting to Shopify</p>
        <p class="subtitle" style="margin-top:6px">Securely reconnecting your store…</p>
      </div>
      <p class="helper">This usually takes a few seconds</p>
    </div>
    <script>
      function doRedirect() {
        var url = '${authUrl}';
        try {
          if (window.shopify && window.shopify.redirectTo) {
            window.shopify.redirectTo(url);
            return;
          }
        } catch(e) {}
        // Fallbacks: try top-frame nav, then same-frame nav
        try { window.top.location.href = url; } catch(e) { window.location.href = url; }
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', doRedirect);
      } else {
        doRedirect();
      }
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
