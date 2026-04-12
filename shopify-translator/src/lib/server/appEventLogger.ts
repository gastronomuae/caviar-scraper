import { supabase } from "@/lib/supabaseClient";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EventStatus = "ok" | "warn" | "error";

export type EventAction =
  | "sync_complete"
  | "sync_error"
  | "push_error"
  | "translate_error"
  | "backup_error"
  | "restore_success"
  | "restore_error"
  | "auth_error";

export interface AppEventInput {
  shop_domain: string;
  action: EventAction;
  status: EventStatus;
  message: string;
  metadata?: Record<string, unknown>;
}

// ── Availability tracking ──────────────────────────────────────────────────────

/**
 * null  = not yet determined (first call will probe)
 * true  = Supabase logs table is reachable and accepting inserts
 * false = unavailable — all subsequent calls are silent no-ops
 */
let _available: boolean | null = null;

/**
 * Called once on first failure to emit a single informational log.
 * Subsequent failures are silently discarded so nothing spams the console.
 */
function markUnavailable(reason: string): void {
  if (_available !== false) {
    console.info(
      `[appEventLogger] not configured — events will be dropped silently (${reason})`
    );
  }
  _available = false;
}

// ── Logger ────────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget event logger. Never throws — caller must never await this
 * in a way that could block or fail the main request.
 *
 * If Supabase is not configured or unreachable the first failure is logged once
 * at the INFO level; all subsequent calls are silent no-ops until the process
 * restarts (preventing per-request warning spam).
 */
export function logAppEvent(input: AppEventInput): void {
  // Fast-path: already confirmed unavailable — drop silently
  if (_available === false) return;

  // Guard: check env vars before ever touching the Supabase client
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    markUnavailable("SUPABASE_URL / SUPABASE_ANON_KEY not set");
    return;
  }

  void (async () => {
    try {
      const row: Record<string, unknown> = {
        shop_domain: input.shop_domain || "unknown",
        action:      input.action,
        status:      input.status,
        message:     input.message,
      };
      if (input.metadata !== undefined) {
        row.metadata = input.metadata;
      }

      const { error } = await supabase.from("logs").insert(row);

      if (error) {
        // Ignore "metadata column does not exist" — migration not yet applied.
        if (error.message.includes("metadata")) return;
        // Any other DB-level error: log once, then silence
        markUnavailable(`DB error: ${error.message}`);
      } else {
        // Confirmed working — mark ready so future calls skip the env guard
        _available = true;
      }
    } catch (err: unknown) {
      // Network/config error (e.g. "fetch failed", wrong URL) — log once, then silence
      markUnavailable(err instanceof Error ? err.message : String(err));
    }
  })();
}
