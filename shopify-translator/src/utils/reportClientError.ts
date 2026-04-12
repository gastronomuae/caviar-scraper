import type { ClientErrorPayload } from "@/app/api/client-error/route";

/** Fire-and-forget: POST error details to /api/client-error for server-side logging. */
export function reportClientError(
  action: string,
  message: string,
  shop?: string
): void {
  try {
    const payload: ClientErrorPayload = {
      shop,
      action,
      message: message.slice(0, 500),
      url: typeof window !== "undefined" ? window.location.href : undefined,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    };
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {/* swallow — logging must never throw */});
  } catch {
    /* swallow */
  }
}
