import { Redis } from "@upstash/redis";

let client: Redis | null | undefined;

/**
 * Upstash Redis REST client. Uses primary env vars from Vercel / Upstash;
 * falls back to legacy Vercel KV names when unset.
 *
 * @returns Singleton client, or `null` if URL/token are missing (caller may use in-memory fallback).
 */
export function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();
  if (!url || !token) return null;
  if (client === undefined) {
    client = new Redis({ url, token });
  }
  return client;
}
