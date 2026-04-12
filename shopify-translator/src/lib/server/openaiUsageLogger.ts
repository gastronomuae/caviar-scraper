import { supabase } from "@/lib/supabaseClient";

// ── Pricing config ────────────────────────────────────────────────────────────
// Cost per token in USD. Update values here when OpenAI changes pricing.
// Source: https://openai.com/api/pricing (last checked Apr 2026)

const PRICING: Record<string, { promptPerToken: number; completionPerToken: number }> = {
  // $2.50 / 1M prompt tokens, $10.00 / 1M completion tokens
  "gpt-4o": {
    promptPerToken:     0.0000025,
    completionPerToken: 0.00001,
  },
  // $0.15 / 1M prompt tokens, $0.60 / 1M completion tokens
  "gpt-4o-mini": {
    promptPerToken:     0.00000015,
    completionPerToken: 0.0000006,
  },
  // TODO: verify gpt-4.1 pricing — using estimate $2.00/$8.00 per 1M
  "gpt-4.1": {
    promptPerToken:     0.000002,
    completionPerToken: 0.000008,
  },
  // TODO: verify gpt-4.1-mini pricing — using estimate $0.40/$1.60 per 1M
  "gpt-4.1-mini": {
    promptPerToken:     0.0000004,
    completionPerToken: 0.0000016,
  },
};

/** Fallback pricing for unknown models — uses gpt-4o rates to avoid zero-cost logs. */
const FALLBACK_PRICING = PRICING["gpt-4o"];

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICING[model] ?? FALLBACK_PRICING;
  return p.promptPerToken * promptTokens + p.completionPerToken * completionTokens;
}

// ── Usage accumulator ─────────────────────────────────────────────────────────
// Shared mutable object threaded through translation calls.

export interface UsageEntry {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type UsageCollector = UsageEntry[];

export function makeUsageCollector(): UsageCollector {
  return [];
}

export function sumUsage(collector: UsageCollector): UsageEntry {
  return collector.reduce(
    (acc, u) => ({
      prompt_tokens:     acc.prompt_tokens     + u.prompt_tokens,
      completion_tokens: acc.completion_tokens + u.completion_tokens,
      total_tokens:      acc.total_tokens      + u.total_tokens,
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  );
}

// ── Logger ────────────────────────────────────────────────────────────────────

export interface OpenAIUsageLogInput {
  shop_domain:       string;
  model:             string;
  prompt_tokens:     number;
  completion_tokens: number;
  total_tokens:      number;
  request_type?:     string;
}

/**
 * Fire-and-forget. Never throws — translation must succeed even if logging fails.
 */
export function logOpenAIUsage(input: OpenAIUsageLogInput): void {
  const estimated_cost = estimateCost(input.model, input.prompt_tokens, input.completion_tokens);

  void (async () => {
    try {
      const { error } = await supabase.from("openai_usage_logs").insert({
        shop_domain:       input.shop_domain || "unknown",
        model:             input.model,
        prompt_tokens:     input.prompt_tokens,
        completion_tokens: input.completion_tokens,
        total_tokens:      input.total_tokens,
        estimated_cost,
        request_type:      input.request_type ?? "translate",
      });
      if (error) {
        console.warn("[openaiUsageLogger] insert failed:", error.message);
      }
    } catch (err: unknown) {
      console.warn("[openaiUsageLogger] unexpected error:", err instanceof Error ? err.message : err);
    }
  })();
}
