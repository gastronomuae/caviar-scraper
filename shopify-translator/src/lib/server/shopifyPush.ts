/**
 * Shared throttle-aware translationsRegister utility.
 *
 * Every `translationsRegister` mutation in this codebase goes through here so
 * that throttle detection, adaptive back-off, THROTTLED retry, and cost logging
 * are consistent across all call sites.
 *
 * Call sites:
 *   /api/shopify/push                  — single-resource push
 *   /api/shopify/translate-options     — batched 25-per-document push
 *   /api/shopify/backup/restore        — restore from backup
 *   /api/internal/restore              — internal support restore
 */

import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";

const API_VERSION = SHOPIFY_ADMIN_API_VERSION;

/** Number of leading batches whose cost is always logged (for observability). */
const LOG_COST_BATCHES = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Shopify response shapes ───────────────────────────────────────────────────

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface CostExtension {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: ThrottleStatus;
}

interface ShopifyError {
  message: string;
  extensions?: { code?: string };
}

interface GqlResponse {
  data?: unknown;
  errors?: ShopifyError[];
  extensions?: { cost?: CostExtension };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Accumulates push telemetry across all batches in a single operation.
 * Pass the same instance to every pushSingleResource / pushBatch call so stats
 * span the entire push phase, then include them in your response JSON.
 */
export interface PushStats {
  totalBatches: number;
  throttledBatches: number;
  retriedBatches: number;
  /** Highest actualQueryCost seen across all documents in this run. */
  peakBucketUsage: number;
}

export function createPushStats(): PushStats {
  return { totalBatches: 0, throttledBatches: 0, retriedBatches: 0, peakBucketUsage: 0 };
}

// ── Types shared with call sites ──────────────────────────────────────────────

export interface TranslationInput {
  locale: string;
  key: string;
  value: string;
  translatableContentDigest: string;
}

export interface BatchPushItem {
  resourceId: string;
  key: string;
  value: string;
  digest: string;
  locale: string;
}

export interface SinglePushResult {
  pushed: number;
  fields: string[];
  userErrors: Array<{ field: string; message: string }>;
}

export interface BatchPushResult {
  succeeded: number;
  failed: number;
}

// ── Core raw HTTP helper ──────────────────────────────────────────────────────

async function shopifyGqlRaw(
  domain: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GqlResponse> {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  return (await res.json()) as GqlResponse;
}

// ── Throttle helpers ──────────────────────────────────────────────────────────

function isThrottled(resp: GqlResponse): boolean {
  return (resp.errors ?? []).some((e) => e.extensions?.code === "THROTTLED");
}

/**
 * Adaptive delay based on the throttle bucket status returned by Shopify.
 * Mirrors the logic described in the API design:
 *
 *   available < cost*3  → bucket nearly empty, wait 2 s for refill
 *   available < 300     → getting low, pause 500 ms
 *   otherwise           → healthy, minimal 100 ms courtesy delay
 */
async function adaptiveThrottle(
  ext: { cost?: CostExtension } | undefined,
  tag: string,
): Promise<void> {
  const cost      = ext?.cost?.actualQueryCost      ?? 10;
  const available = ext?.cost?.throttleStatus?.currentlyAvailable ?? 1000;

  if (available < cost * 3) {
    console.info(`[shopifyPush/${tag}] bucket low (${available} < ${cost * 3}) — waiting 2 s`);
    await sleep(2000);
  } else if (available < 300) {
    console.info(`[shopifyPush/${tag}] bucket moderate (${available}) — waiting 500 ms`);
    await sleep(500);
  } else {
    await sleep(100);
  }
}

function logCostIfEarly(batchIndex: number, ext: { cost?: CostExtension } | undefined, tag: string): void {
  if (batchIndex >= LOG_COST_BATCHES) return;
  const cost      = ext?.cost?.actualQueryCost;
  const available = ext?.cost?.throttleStatus?.currentlyAvailable;
  const restore   = ext?.cost?.throttleStatus?.restoreRate;
  console.info(
    `[shopifyPush/${tag}] batch=${batchIndex} actualCost=${cost ?? "?"} ` +
    `available=${available ?? "?"} restoreRate=${restore ?? "?"}/s`,
  );
}

function updateStats(stats: PushStats | undefined, ext: { cost?: CostExtension } | undefined): void {
  if (!stats) return;
  stats.totalBatches++;
  const cost = ext?.cost?.actualQueryCost ?? 0;
  if (cost > stats.peakBucketUsage) stats.peakBucketUsage = cost;
}

// ── Single-resource push ──────────────────────────────────────────────────────

const REGISTER_MUTATION = `
  mutation RegisterTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations { locale key value }
      userErrors { field message }
    }
  }
`;

/**
 * Push translations for a single Shopify resource.
 * Retries once if the response is THROTTLED.
 *
 * @param batchIndex Used for cost logging — pass a monotonically increasing
 *   counter if calling in a loop, or 0 for one-shot calls.
 */
export async function pushSingleResource(
  domain: string,
  token: string,
  resourceId: string,
  translations: TranslationInput[],
  opts: { stats?: PushStats; batchIndex?: number; tag?: string } = {},
): Promise<SinglePushResult> {
  const { stats, batchIndex = 0, tag = "single" } = opts;
  const vars = { resourceId, translations };

  let resp = await shopifyGqlRaw(domain, token, REGISTER_MUTATION, vars);

  // ── Retry on THROTTLED ────────────────────────────────────────────────────
  if (isThrottled(resp)) {
    console.warn(`[shopifyPush/${tag}] THROTTLED on batch=${batchIndex}, retrying after 2 s`);
    if (stats) { stats.throttledBatches++; stats.retriedBatches++; }
    await sleep(2000);
    resp = await shopifyGqlRaw(domain, token, REGISTER_MUTATION, vars);
  }

  logCostIfEarly(batchIndex, resp.extensions, tag);
  updateStats(stats, resp.extensions);
  await adaptiveThrottle(resp.extensions, tag);

  if (resp.errors?.length && !isThrottled(resp)) {
    throw new Error(`Shopify GraphQL: ${resp.errors[0].message}`);
  }

  const result = (resp.data as { translationsRegister?: { translations?: Array<{ key: string }>; userErrors?: Array<{ field: string; message: string }> } })?.translationsRegister;
  return {
    pushed:     result?.translations?.length ?? 0,
    fields:     (result?.translations ?? []).map((t) => t.key),
    userErrors: result?.userErrors ?? [],
  };
}

// ── Batched push (25 aliased mutations per document) ─────────────────────────

/**
 * Push translations for up to 25 resources in a single GraphQL document using
 * aliased mutations. We already have the translatableContentDigest from the
 * fetch phase, so no extra round-trip is required.
 *
 * Retries the entire document once if THROTTLED.
 */
export async function pushBatch(
  domain: string,
  token: string,
  items: BatchPushItem[],
  batchIndex: number,
  opts: { stats?: PushStats; tag?: string } = {},
): Promise<BatchPushResult> {
  if (items.length === 0) return { succeeded: 0, failed: 0 };
  const { stats, tag = "batch" } = opts;

  // Build aliased mutations — inline interpolation avoids variable-map size limits
  const aliasDefs = items
    .map(
      (item, i) =>
        `m${i}: translationsRegister(resourceId: "${item.resourceId}", translations: [{\n` +
        `      locale: "${item.locale}", key: "${item.key}",\n` +
        `      value: ${JSON.stringify(item.value)},\n` +
        `      translatableContentDigest: "${item.digest}"\n` +
        `    }]) { userErrors { field message } }`,
    )
    .join("\n  ");

  const mutation = `mutation BatchPush {\n  ${aliasDefs}\n}`;

  const executeBatch = async (): Promise<GqlResponse> =>
    shopifyGqlRaw(domain, token, mutation);

  let resp = await executeBatch();

  // ── Retry on THROTTLED ────────────────────────────────────────────────────
  if (isThrottled(resp)) {
    console.warn(`[shopifyPush/${tag}] THROTTLED on batch=${batchIndex}, retrying after 2 s`);
    if (stats) { stats.throttledBatches++; stats.retriedBatches++; }
    await sleep(2000);
    resp = await executeBatch();
  }

  logCostIfEarly(batchIndex, resp.extensions, tag);
  updateStats(stats, resp.extensions);
  await adaptiveThrottle(resp.extensions, tag);

  // HTTP-level or non-throttle GraphQL error → count all as failed
  if (resp.errors?.length && !isThrottled(resp)) {
    console.warn(
      `[shopifyPush/${tag}] batch=${batchIndex} GraphQL error:`,
      resp.errors[0].message,
    );
    return { succeeded: 0, failed: items.length };
  }

  // Count per-alias results
  const data = (resp.data ?? {}) as Record<string, { userErrors?: Array<{ field: string; message: string }> }>;
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const alias = data[`m${i}`];
    if (alias?.userErrors?.length) {
      console.warn(
        `[shopifyPush/${tag}] userError for ${items[i].resourceId}:`,
        alias.userErrors[0].message,
      );
      failed++;
    } else {
      succeeded++;
    }
  }
  return { succeeded, failed };
}

/**
 * Push many items in sequential batches of `batchSize` (default 25).
 * Returns combined results + updates `stats` in place.
 */
export async function pushAllBatched(
  domain: string,
  token: string,
  items: BatchPushItem[],
  opts: { stats?: PushStats; batchSize?: number; tag?: string } = {},
): Promise<{ succeeded: number; failed: number }> {
  const { stats, batchSize = 25, tag = "batch" } = opts;
  let succeeded = 0;
  let failed = 0;
  let batchIndex = 0;

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const slice = items.slice(offset, offset + batchSize);
    const result = await pushBatch(domain, token, slice, batchIndex, { stats, tag });
    succeeded += result.succeeded;
    failed += result.failed;
    batchIndex++;
  }

  console.info(
    `[shopifyPush/${tag}] complete — ` +
    `${succeeded} ok, ${failed} failed, ${batchIndex} batches`,
    stats
      ? `throttled=${stats.throttledBatches} retried=${stats.retriedBatches} peakCost=${stats.peakBucketUsage}`
      : "",
  );

  return { succeeded, failed };
}
