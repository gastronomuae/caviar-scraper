/** Persisted successful Shopify product sync completion time (ISO string). */
export const LAST_SYNC_AT_STORAGE_KEY = "lastSyncAt";
export const LAST_SYNC_META_STORAGE_KEY = "localeflow_sync_meta_v2";

export interface LastSyncMeta {
  timestamp: string;
  labels: string[];
}

export function readLastSyncAt(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(LAST_SYNC_AT_STORAGE_KEY);
    if (!v?.trim()) return null;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) return null;
    return v;
  } catch {
    return null;
  }
}

export function writeLastSyncAt(iso: string): void {
  try {
    localStorage.setItem(LAST_SYNC_AT_STORAGE_KEY, iso);
  } catch {
    /* quota / private mode */
  }
}

export function readLastSyncMeta(): LastSyncMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_SYNC_META_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastSyncMeta>;
    if (!parsed.timestamp || Number.isNaN(Date.parse(parsed.timestamp))) return null;
    const labels = Array.isArray(parsed.labels)
      ? parsed.labels.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    return { timestamp: parsed.timestamp, labels };
  } catch {
    return null;
  }
}

export function writeLastSyncMeta(meta: LastSyncMeta): void {
  try {
    localStorage.setItem(LAST_SYNC_META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    /* quota / private mode */
  }
}

/** Labels like "just now", "5 min ago", "Mar 28, 14:32". */
export function formatLastSyncedRelative(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.floor((nowMs - t) / 1000);
  if (diffSec < 45) return "just now";
  if (diffSec < 3600) {
    const m = Math.max(1, Math.floor(diffSec / 60));
    return `${m} min ago`;
  }
  if (diffSec < 86400) {
    const h = Math.max(1, Math.floor(diffSec / 3600));
    return `${h} hr ago`;
  }
  const d = new Date(t);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
