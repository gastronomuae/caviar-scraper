import { createClient, SupabaseClient } from "@supabase/supabase-js";

// All Supabase access in this app is server-side only (API routes + server libs).
// Use the service role key so RLS policies do not interfere with internal reads/writes.
// NEVER expose SUPABASE_SERVICE_ROLE_KEY to the browser.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL?.trim();
  // Prefer service role key (bypasses RLS); fall back to anon key for local dev without service key.
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
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
