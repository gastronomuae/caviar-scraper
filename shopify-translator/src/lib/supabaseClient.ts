import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Client is created lazily on first use so Next.js static build analysis
// can import this module without SUPABASE_URL / SUPABASE_ANON_KEY being set.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables. Set SUPABASE_URL and SUPABASE_ANON_KEY.",
    );
  }
  _client = createClient(url, key);
  return _client;
}

// Proxy keeps the exported shape identical to the original `supabase` constant
// so no callers need to change.
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? (value as Function).bind(client) : value;
  },
});
