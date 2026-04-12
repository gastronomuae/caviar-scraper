import type { ShopifySyncProductRow } from "@/types";

type NdjsonEvent = {
  type: string;
  processed?: number;
  total?: number | null;
  pct?: number | null;
  /** Legacy: all rows in a single complete event (old protocol). */
  products?: ShopifySyncProductRow[];
  /** New: rows for one resource type, streamed as each type finishes. */
  rows?: ShopifySyncProductRow[];
  resourceType?: string;
  count?: number;
  totalCount?: number;
  message?: string;
};

/** Credentials for POST /api/shopify/sync — access token resolved on the server. */
export interface ShopifySyncFetchCredentials {
  shopifyDomain: string;
  /** Dev fallback when no OAuth token is stored server-side. */
  shopifyClientId?: string;
  shopifyClientSecret?: string;
}

export interface ShopifySyncFetchOptions {
  /** Default true — NDJSON progress stream. */
  stream?: boolean;
  type?: string;
  /** Target locale for this sync run, e.g. "en". Server falls back to its DEFAULT if omitted. */
  targetLocale?: string;
  /**
   * ISO timestamp — when set, only products updated at or after this time are fetched.
   * Used for incremental sync (Stage 2). Only affects the PRODUCT pipeline.
   */
  updatedAtFilter?: string;
  /**
   * When true, bypass the server-side in-memory result cache and force a fresh
   * Shopify pull. Does NOT affect the backup snapshot guard.
   */
  force?: boolean;
  /**
   * When true, bypass the "already backed up" type guard so the backup snapshot
   * is overwritten with the fresh sync data. Independent of `force`.
   */
  forceBackup?: boolean;
}

/** Client-side fetch timeout — 270 s gives the Vercel 300 s limit a 30 s margin. */
const SYNC_FETCH_TIMEOUT_MS = 270_000;

/**
 * POST /api/shopify/sync — token resolved server-side (OAuth JSON store or dev credentials).
 * The AbortController covers the full duration: initial connection AND the streaming read.
 *
 * @param onTypeRows  Optional callback fired per resource type as it finishes.
 *                    Rows are delivered here before the overall Promise resolves,
 *                    enabling progressive UI updates (e.g. show products at 45 s).
 */
export async function fetchShopifySyncProductRows(
  credentials: ShopifySyncFetchCredentials,
  onProgress: (pct: number) => void,
  options: ShopifySyncFetchOptions = {},
  onTypeRows?: (resourceType: string, rows: ShopifySyncProductRow[]) => void
): Promise<ShopifySyncProductRow[]> {
  const { stream = true, type, targetLocale, updatedAtFilter, force, forceBackup } = options;

  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), SYNC_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch("/api/shopify/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abort.signal,
      body: JSON.stringify({
        shopifyDomain: credentials.shopifyDomain,
        shopifyClientId: credentials.shopifyClientId,
        shopifyClientSecret: credentials.shopifyClientSecret,
        stream,
        ...(type           ? { type }              : {}),
        ...(targetLocale   ? { targetLocale }       : {}),
        ...(updatedAtFilter ? { updatedAtFilter }   : {}),
        ...(force          ? { force:       true }  : {}),
        ...(forceBackup    ? { forceBackup: true }  : {}),
      }),
    });

    if (!res.ok) {
      const data: unknown = await res.json().catch(() => ({}));
      const err = data as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }

    const ct = res.headers.get("content-type") ?? "";

    if (ct.includes("ndjson")) {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let rows: ShopifySyncProductRow[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as NdjsonEvent;
          if (ev.type === "progress") {
            // Cap at 99 while streaming — 100% is only emitted once the complete
            // payload is fully received, so the UI doesn't get stuck at "100%" while
            // still buffering a potentially large complete event.
            if (ev.pct != null) {
              onProgress(Math.min(99, ev.pct));
            } else if (ev.total != null && ev.processed != null && ev.total > 0) {
              onProgress(Math.min(99, Math.round((ev.processed / ev.total) * 100)));
            }
          }
        if (ev.type === "error") {
          throw new Error(ev.message ?? "Sync failed");
        }
        // New protocol: per-type rows streamed as each type finishes.
        if (ev.type === "typeRows" && ev.rows && ev.resourceType) {
          rows.push(...ev.rows);
          onTypeRows?.(ev.resourceType, ev.rows);
        }
        // Legacy protocol: all rows in a single complete event.
        // New protocol: complete carries only totalCount (rows already received).
        if (ev.type === "complete") {
          if (ev.products) {
            rows = ev.products; // legacy: overwrite with authoritative full set
          }
          onProgress(100);
        }
      }
    }
    if (buffer.trim()) {
      const ev = JSON.parse(buffer) as NdjsonEvent;
      if (ev.type === "error") throw new Error(ev.message ?? "Sync failed");
      if (ev.type === "typeRows" && ev.rows && ev.resourceType) {
        rows.push(...ev.rows);
        onTypeRows?.(ev.resourceType, ev.rows);
      }
      if (ev.type === "complete") {
        if (ev.products) rows = ev.products;
        onProgress(100);
      }
    }
    return rows;
    }

    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      throw new Error("Unexpected response from /api/shopify/sync");
    }
    onProgress(100);
    return data as ShopifySyncProductRow[];
  } finally {
    clearTimeout(timeoutId);
  }
}
