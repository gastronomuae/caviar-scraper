import crypto from "crypto";

/**
 * Webhook signing secret from Shopify Partners (same as app API secret for many apps).
 * Set in production so HMAC verification runs; if unset, verification is skipped (local dev only).
 */
export function getShopifyWebhookSecret(): string | undefined {
  const s =
    process.env.SHOPIFY_WEBHOOK_SECRET?.trim() ||
    process.env.SHOPIFY_CLIENT_SECRET?.trim() ||
    process.env.SHOPIFY_API_SECRET?.trim();
  return s || undefined;
}

/**
 * Verifies `X-Shopify-Hmac-Sha256` against the raw request body.
 * When no secret is configured, returns true (development only — configure secret in production).
 */
export function verifyShopifyWebhookSignature(rawBody: string, hmacHeader: string | null): boolean {
  const secret = getShopifyWebhookSecret();
  if (!secret) return true;
  if (!hmacHeader) return false;

  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  if (digest.length !== hmacHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmacHeader, "utf8"));
  } catch {
    return false;
  }
}
