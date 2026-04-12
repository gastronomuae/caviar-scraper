import { getRedis } from "@/lib/redis";

/**
 * Set `TOKEN_STORE_DEBUG=1` to log GET/SET and source. Remove after verification (grep `[token-store-debug]`).
 *
 * Quick check: store token (OAuth) → logs "Token stored in Redis" → restart `next dev`
 * (cold start) → trigger any API that resolves token → logs "Token retrieved from Redis".
 */
const TOKEN_STORE_DEBUG = process.env.TOKEN_STORE_DEBUG === "1";

function dbg(...args: unknown[]) {
  if (TOKEN_STORE_DEBUG) console.info("[token-store-debug]", ...args);
}

export type ShopifyTokenEntry = {
  access_token: string;
  updated_at: string;
  /** How the token was last set (for debugging / support). */
  source?: "oauth" | "client_credentials";
};

function currentAppKey(): string {
  return (process.env.SHOPIFY_API_KEY ?? "default").trim() || "default";
}

/** Storage key: `${SHOPIFY_API_KEY}::${shop}` — `shop` is normalized `*.myshopify.com`. */
function appScopedStoreKey(shopDomain: string): string {
  const domain = normalizeShopifyAdminDomain(shopDomain);
  if (!domain) return "";
  return `${currentAppKey()}::${domain}`;
}

/** Debug helper for logging exact storage key used for a shop. */
export function debugTokenStoreKey(shopDomain: string): string {
  return appScopedStoreKey(shopDomain);
}

export function tokenCookieName(shopDomain: string): string {
  const domain = normalizeShopifyAdminDomain(shopDomain);
  const appKey = currentAppKey().replace(/[^a-zA-Z0-9_-]/g, "_");
  const domainPart = domain.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `shopify_token_${appKey}_${domainPart}`;
}

/**
 * Returns all legacy cookie name formats that older code versions may have set.
 * Used to clean them up in OAuth callbacks and to fall back during token resolution.
 */
export function legacyTokenCookieNames(shopDomain: string): string[] {
  const domain = normalizeShopifyAdminDomain(shopDomain);
  const domainSanitized = domain.replace(/[^a-zA-Z0-9_-]/g, "_");
  return [
    `shopify_token_${domain}`,
    `shopify_token_default_${domainSanitized}`,
  ];
}

/** In-memory fallback when Redis env is not configured (local dev only). */
const memoryFallback = new Map<string, ShopifyTokenEntry>();
let warnedMemoryFallback = false;

async function readEntry(key: string, shop: string): Promise<ShopifyTokenEntry | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const v = await redis.get<ShopifyTokenEntry>(key);
      if (v) {
        dbg("Token retrieved from Redis", { shop });
        return v;
      }
      dbg("Redis GET miss (no entry for shop)", { shop });
    } catch (err) {
      console.error("[token-store] Redis GET failed:", err instanceof Error ? err.message : err);
    }
  } else if (!warnedMemoryFallback) {
    console.warn(
      "[token-store] UPSTASH_REDIS_* / KV_REST_* not set — using in-memory token store (not persistent across instances; set Redis env for production).",
    );
    warnedMemoryFallback = true;
  }

  const mem = memoryFallback.get(key) ?? null;
  if (mem) {
    dbg("Token retrieved from memory fallback", { shop });
  } else {
    dbg("Memory fallback GET miss", { shop });
  }
  return mem;
}

async function writeEntry(key: string, entry: ShopifyTokenEntry, shop: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(key, entry);
      dbg("Token stored in Redis", { shop });
    } catch (err) {
      console.error("[token-store] Redis SET failed:", err instanceof Error ? err.message : err);
      throw err;
    }
    return;
  }
  memoryFallback.set(key, entry);
  dbg("Token stored in memory fallback", { shop });
}

async function deleteEntry(key: string, shop: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(key);
      dbg("Token deleted from Redis", { shop });
    } catch (err) {
      console.error("[token-store] Redis DEL failed:", err instanceof Error ? err.message : err);
      throw err;
    }
    return;
  }
  memoryFallback.delete(key);
  dbg("Token deleted from memory fallback", { shop });
}

/** Normalize to `*.myshopify.com` (matches sync/push routes). */
export function normalizeShopifyAdminDomain(raw: string): string {
  const clean = (raw ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
  if (!clean) return "";
  return clean.includes(".myshopify.com") ? clean : `${clean}.myshopify.com`;
}

export async function getStoredAccessToken(shopDomain: string): Promise<string | null> {
  const key = appScopedStoreKey(shopDomain);
  if (!key) return null;
  const entry = await readEntry(key, shopDomain);
  if (!entry) return null;
  if (entry.source === "client_credentials") {
    await deleteStoredAccessToken(shopDomain);
    console.warn(`[token-store] Purged client_credentials token for ${shopDomain}`);
    return null;
  }
  return entry.access_token ?? null;
}

/**
 * Cookie-aware token lookup — reads from the request's cookie header.
 * Checks the current cookie name format first, then falls back to legacy formats.
 */
export function getTokenFromCookieHeader(
  shopDomain: string,
  cookieHeader: string | null,
): string | null {
  if (!cookieHeader || !shopDomain) return null;
  const allCookies = cookieHeader.split(";").map((c) => c.trim());

  const namesToCheck = [tokenCookieName(shopDomain), ...legacyTokenCookieNames(shopDomain)];
  for (const name of namesToCheck) {
    const match = allCookies.find((c) => c.startsWith(`${name}=`));
    if (match) {
      const value = decodeURIComponent(match.slice(name.length + 1));
      if (value) {
        if (name !== tokenCookieName(shopDomain)) {
          console.info(`[token-store] Found token in legacy cookie "${name}" for ${shopDomain}`);
        }
        return value;
      }
    }
  }
  return null;
}

/**
 * Queries Supabase `stores` table for a token and re-hydrates Redis when found.
 * Used as a final fallback when Redis misses and no cookie is present (cross-device / cold start).
 * Does not import the shared supabase singleton to avoid crashing when env vars are absent.
 */
async function resolveTokenFromSupabase(shopDomain: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(url, key);
    const { data, error } = await sb
      .from("stores")
      .select("access_token")
      .eq("shop_domain", shopDomain)
      .single();
    if (error || !data?.access_token) return null;
    console.info(`[token-store] Supabase fallback hit for ${shopDomain} — re-hydrating Redis`);
    await setStoredAccessToken(shopDomain, data.access_token, "oauth");
    return data.access_token as string;
  } catch (err) {
    console.warn("[token-store] Supabase fallback failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolves token using a three-layer lookup:
 *   1. Redis / memory store  — fastest, shared across all serverless instances
 *   2. Request cookie        — device-specific; re-hydrates Redis on match
 *   3. Supabase stores table — durable fallback for cross-device access and Redis cold starts
 */
export async function resolveToken(
  shopDomain: string,
  cookieHeader?: string | null,
): Promise<string | null> {
  const fromStore = await getStoredAccessToken(shopDomain);
  const fromCookie = getTokenFromCookieHeader(shopDomain, cookieHeader ?? null);

  if (fromCookie && fromCookie !== fromStore) {
    const reason = fromStore ? "differs from store (OAuth on warm instance)" : "store empty (cold start)";
    console.info(
      `[token-store] Using cookie token for ${shopDomain} — ${reason}. ` +
        `store=${fromStore ? fromStore.slice(0, 10) + "..." : "none"} cookie=${fromCookie.slice(0, 10)}...`,
    );
    dbg("Token source: cookie (persisting to store)", { shop: shopDomain });
    await setStoredAccessToken(shopDomain, fromCookie, "oauth");
    return fromCookie;
  }

  if (fromStore) {
    dbg("Token source: store", {
      shop: shopDomain,
      layer: getRedis() ? "redis" : "memory-fallback",
    });
    return fromStore;
  }

  // Redis miss + cookie miss → try Supabase as durable cross-device fallback.
  const fromSupabase = await resolveTokenFromSupabase(shopDomain);
  if (fromSupabase) return fromSupabase;

  dbg("Token resolve: no token (store miss, cookie miss, supabase miss)", { shop: shopDomain });
  return null;
}

export async function hasStoredAccessToken(shopDomain: string): Promise<boolean> {
  return !!(await getStoredAccessToken(shopDomain));
}

export async function setStoredAccessToken(
  shopDomain: string,
  accessToken: string,
  source: ShopifyTokenEntry["source"] = "oauth",
): Promise<void> {
  const key = appScopedStoreKey(shopDomain);
  if (!key || !accessToken) return;
  await writeEntry(
    key,
    {
      access_token: accessToken,
      updated_at: new Date().toISOString(),
      source,
    },
    shopDomain,
  );
}

export async function deleteStoredAccessToken(shopDomain: string): Promise<void> {
  const key = appScopedStoreKey(shopDomain);
  if (!key) return;
  await deleteEntry(key, shopDomain);
}
