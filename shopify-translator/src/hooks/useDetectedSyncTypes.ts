"use client";

import { useEffect, useState } from "react";
import type { ShopifySyncResourceType } from "@/types";

export type DetectionState = "idle" | "loading" | "done" | "error";

const SESSION_KEY_PREFIX = "detectedSyncTypes_";

function cacheKey(shop: string) {
  return `${SESSION_KEY_PREFIX}${shop}`;
}

function readCache(shop: string): ShopifySyncResourceType[] | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(shop));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { types: ShopifySyncResourceType[]; ts: number };
    // Cache valid for 1 hour within the session.
    if (Date.now() - parsed.ts > 60 * 60 * 1000) return null;
    return parsed.types;
  } catch {
    return null;
  }
}

function writeCache(shop: string, types: ShopifySyncResourceType[]) {
  try {
    sessionStorage.setItem(cacheKey(shop), JSON.stringify({ types, ts: Date.now() }));
  } catch { /* ignore */ }
}

/**
 * Probes Shopify for which translatable resource types actually have content
 * in the connected store.  Result is cached in sessionStorage (1 h TTL).
 *
 * Returns:
 *  - `detectedTypes`: null while loading/idle, string[] when done.
 *  - `detectionState`: "idle" | "loading" | "done" | "error"
 *  - `refresh()`: force a re-probe (clears cache first).
 */
export function useDetectedSyncTypes(shopDomain: string | null | undefined): {
  detectedTypes: ShopifySyncResourceType[] | null;
  detectionState: DetectionState;
  refresh: () => void;
} {
  const [detectedTypes, setDetectedTypes] = useState<ShopifySyncResourceType[] | null>(null);
  const [detectionState, setDetectionState] = useState<DetectionState>("idle");
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!shopDomain) return;

    const cached = readCache(shopDomain);
    if (cached) {
      setDetectedTypes(cached);
      setDetectionState("done");
      return;
    }

    setDetectionState("loading");
    void (async () => {
      try {
        const res = await fetch(
          `/api/shopify/content-types?shop=${encodeURIComponent(shopDomain)}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { types: ShopifySyncResourceType[] };
        writeCache(shopDomain, data.types);
        setDetectedTypes(data.types);
        setDetectionState("done");
      } catch (err) {
        console.warn("[useDetectedSyncTypes] Detection failed:", err);
        setDetectionState("error");
      }
    })();
  }, [shopDomain, refreshTick]);

  function refresh() {
    if (shopDomain) {
      try { sessionStorage.removeItem(cacheKey(shopDomain)); } catch { /* ignore */ }
    }
    setDetectedTypes(null);
    setDetectionState("idle");
    setRefreshTick((n) => n + 1);
  }

  return { detectedTypes, detectionState, refresh };
}
