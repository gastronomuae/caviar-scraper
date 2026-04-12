/**
 * POST /api/shopify/translate-options
 *
 * Digest-deduped translate+push pipeline for PRODUCT_OPTION and
 * PRODUCT_OPTION_VALUE. Runs entirely server-side.
 *
 * Why: these types have ~3,400 records but only ~20-30 unique source strings
 * (one digest = one unique source text). The regular per-record flow calls
 * OpenAI once per record (3,400 calls). This route calls OpenAI once per
 * unique digest (~25 calls) and reuses existing translations where available.
 *
 * Flow
 * ────
 * 1. Fetch all PRODUCT_OPTION + PRODUCT_OPTION_VALUE via translatableResources
 *    (paginated, including existing translations so we can detect outdated: false).
 * 2. Build a digestMap per (key, digest) pair:
 *    – resourceIdsNeedingPush   = no current translation yet
 *    – resourceIdsAlreadyDone   = outdated: false → translation already current
 *    – existingTranslation      = reusable text from any "done" resourceId
 * 3. Translate unique digests via OpenAI (one batched call).
 *    Skip digests where existingTranslation is already available.
 * 4. Push via translationsRegister in batches of 25 (GraphQL aliased mutations).
 *    We already have the digest from step 1, so no extra fetchDigests call needed.
 * 5. Return stats including reduction percentage.
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { resolveShopifyAccessToken } from "@/lib/server/resolveShopifyAccessToken";
import { normalizeShopifyAdminDomain } from "@/lib/server/shopifyTokenStore";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/shopifyAdminApiVersion";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT } from "@/lib/translationDefaults";
import {
  makeUsageCollector,
  sumUsage,
  logOpenAIUsage,
} from "@/lib/server/openaiUsageLogger";
import {
  pushAllBatched,
  createPushStats,
  type BatchPushItem,
  type PushStats,
} from "@/lib/server/shopifyPush";

const API_VERSION = SHOPIFY_ADMIN_API_VERSION;
const FETCH_PAGE_SIZE = 250;

const RESOURCE_TYPES = ["PRODUCT_OPTION", "PRODUCT_OPTION_VALUE"] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql<T = unknown>(
  domain: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors[0].message}`);
  return json.data as T;
}

// ── Data structures ───────────────────────────────────────────────────────────

interface TranslationItem { key: string; value: string; outdated: boolean }
interface ContentItem      { key: string; value: string; digest: string; locale: string }
interface FetchedNode {
  resourceId: string;
  translatableContent: ContentItem[];
  translations: TranslationItem[];
}

interface TranslatableResourcesPage {
  translatableResources: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: FetchedNode[];
  };
}

/**
 * One entry per unique (fieldKey + digest) combination.
 * Many productOption records share the same source text and therefore the same
 * digest — they will all share a single DigestEntry.
 */
interface DigestEntry {
  key: string;                    // Shopify field key (e.g. "name")
  sourceText: string;
  digest: string;
  existingTranslation: string | null;   // reusable translation from an already-done record
  resourceIdsNeedingPush: string[];     // resourceIds without a current (outdated:false) translation
  resourceIdsAlreadyDone: string[];     // resourceIds already current — no push needed
  newTranslation: string | null;        // filled by OpenAI step
}

// ── Fetch phase ───────────────────────────────────────────────────────────────

const FETCH_QUERY = (resourceType: ResourceType) => `
  query FetchOptions($first: Int!, $after: String, $locale: String!) {
    translatableResources(resourceType: ${resourceType}, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        resourceId
        translatableContent { key value digest locale }
        translations(locale: $locale) { key value outdated }
      }
    }
  }
`;

async function fetchAllNodes(
  domain: string,
  token: string,
  resourceType: ResourceType,
  targetLocale: string,
): Promise<FetchedNode[]> {
  const nodes: FetchedNode[] = [];
  let after: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const data: TranslatableResourcesPage = await gql<TranslatableResourcesPage>(
      domain, token, FETCH_QUERY(resourceType), {
        first: FETCH_PAGE_SIZE,
        after,
        locale: targetLocale,
      });

    const conn = data.translatableResources;
    nodes.push(...conn.nodes);
    hasNext = conn.pageInfo.hasNextPage;
    after = conn.pageInfo.endCursor;
  }

  return nodes;
}

// ── Digest map building ───────────────────────────────────────────────────────

function buildDigestMap(nodes: FetchedNode[]): Map<string, DigestEntry> {
  const map = new Map<string, DigestEntry>();

  for (const node of nodes) {
    const translationsByKey = new Map(node.translations.map((t) => [t.key, t]));

    for (const item of node.translatableContent) {
      if (!item.value?.trim() || !item.digest) continue;

      const mapKey = `${item.key}:${item.digest}`;
      let entry = map.get(mapKey);
      if (!entry) {
        entry = {
          key: item.key,
          sourceText: item.value,
          digest: item.digest,
          existingTranslation: null,
          resourceIdsNeedingPush: [],
          resourceIdsAlreadyDone: [],
          newTranslation: null,
        };
        map.set(mapKey, entry);
      }

      const existing = translationsByKey.get(item.key);
      if (existing && !existing.outdated && existing.value?.trim()) {
        // This resourceId already has a current (non-outdated) translation.
        entry.resourceIdsAlreadyDone.push(node.resourceId);
        // Capture the translation text so we can push it to other resourceIds cheaply.
        if (!entry.existingTranslation) {
          entry.existingTranslation = existing.value;
        }
      } else {
        entry.resourceIdsNeedingPush.push(node.resourceId);
      }
    }
  }

  return map;
}

// ── OpenAI translate phase ────────────────────────────────────────────────────

function localeName(code: string): string {
  const map: Record<string, string> = {
    ru: "Russian", en: "English", de: "German", fr: "French",
    es: "Spanish", it: "Italian", pt: "Portuguese", ar: "Arabic",
    zh: "Chinese", ja: "Japanese", ko: "Korean", nl: "Dutch",
    pl: "Polish", tr: "Turkish", sv: "Swedish", da: "Danish",
    fi: "Finnish", nb: "Norwegian", cs: "Czech", sk: "Slovak",
    ro: "Romanian", uk: "Ukrainian",
  };
  return map[code.toLowerCase().split("-")[0]] ?? code;
}

async function translateUniqueDigests(
  entriesToTranslate: DigestEntry[],
  model: string,
  systemPrompt: string,
  sourceLocale: string,
  targetLocale: string,
  shopDomain: string,
): Promise<void> {
  if (entriesToTranslate.length === 0) return;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const usageCollector = makeUsageCollector();
  const srcName = localeName(sourceLocale);
  const tgtName = localeName(targetLocale);

  const criticalPrefix = `CRITICAL LANGUAGE RULES:
- You MUST translate all input text into the target language
- You MUST NOT return the original source language text
- You are NOT allowed to return the input unchanged
- Even for very short text, ALWAYS translate`;

  const finalPrompt = criticalPrefix + "\n\n" + systemPrompt;

  // Use digest index as stable key for the batch call
  const inputPayload = entriesToTranslate.map((entry, i) => ({
    key: `d${i}`,
    instruction: `Translate the product option name from ${srcName} to ${tgtName}. Keep it concise.`,
    text: entry.sourceText,
  }));

  const userMessage =
    `Translate each item from ${srcName} to ${tgtName} following its instruction.\n` +
    `Output ONLY in ${tgtName} — NEVER in ${srcName}.\n` +
    `Return a JSON object: {"translations":[{"key":"<key>","translation":"<translated text>"}...]}\n\n` +
    `Items to translate:\n` +
    JSON.stringify(inputPayload, null, 2);

  const maxTokens = Math.min(entriesToTranslate.length * 30 + 200, 4096);

  console.info(
    `[translate-options] Calling OpenAI: ${entriesToTranslate.length} unique digests`,
    `model=${model}`,
  );

  let parsed: Array<{ key: string; translation: string }> = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: finalPrompt },
          { role: "user",   content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      });

      if (usageCollector && completion.usage) {
        usageCollector.push({
          prompt_tokens:     completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          total_tokens:      completion.usage.total_tokens,
        });
      }

      const raw = completion.choices[0]?.message?.content?.trim() ?? "";
      console.info(`[translate-options] raw_response=${raw.slice(0, 500)}`);

      const obj = JSON.parse(raw) as unknown;
      const arr = Array.isArray(obj)
        ? obj
        : (obj && typeof obj === "object" && "translations" in obj)
          ? (obj as { translations: typeof parsed }).translations
          : Object.values(obj as Record<string, unknown>).find(Array.isArray) ?? [];
      parsed = arr as typeof parsed;
      break;
    } catch (err) {
      console.error(`[translate-options] OpenAI attempt ${attempt} failed:`, err);
      if (attempt === 2) {
        // On total failure, copy source text as fallback
        for (const entry of entriesToTranslate) {
          entry.newTranslation = entry.sourceText;
        }
        return;
      }
    }
  }

  // Apply translations back to entries
  const byKey = new Map(parsed.map((p) => [p.key, p.translation ?? ""]));
  for (let i = 0; i < entriesToTranslate.length; i++) {
    entriesToTranslate[i].newTranslation = byKey.get(`d${i}`) ?? entriesToTranslate[i].sourceText;
  }

  const totalUsage = sumUsage(usageCollector);
  if (totalUsage.total_tokens > 0) {
    logOpenAIUsage({
      shop_domain:       shopDomain,
      model,
      prompt_tokens:     totalUsage.prompt_tokens,
      completion_tokens: totalUsage.completion_tokens,
      total_tokens:      totalUsage.total_tokens,
      request_type:      `translate-options(${entriesToTranslate.length})`,
    });
  }
}

// ── Push phase — delegated to shared shopifyPush utility ─────────────────────

async function pushAllForType(
  domain: string,
  token: string,
  digestMap: Map<string, DigestEntry>,
  targetLocale: string,
  pushStats: PushStats,
  resourceType: string,
): Promise<{ pushSucceeded: number; pushFailed: number }> {
  const pushItems: BatchPushItem[] = [];

  for (const entry of digestMap.values()) {
    const translationValue = entry.newTranslation ?? entry.existingTranslation;
    if (!translationValue) continue;
    for (const resourceId of entry.resourceIdsNeedingPush) {
      pushItems.push({
        resourceId,
        key: entry.key,
        value: translationValue,
        digest: entry.digest,
        locale: targetLocale,
      });
    }
  }

  const { succeeded, failed } = await pushAllBatched(domain, token, pushItems, {
    stats: pushStats,
    batchSize: 25,
    tag: `translate-options/${resourceType}`,
  });

  return { pushSucceeded: succeeded, pushFailed: failed };
}

// ── Stats types ───────────────────────────────────────────────────────────────

interface TypeStats {
  totalRecords: number;
  uniqueDigests: number;
  digestsAlreadyTranslated: number;    // skipped OpenAI — existingTranslation reused
  digestsTranslatedByOpenAI: number;
  openAiCallsSaved: number;            // totalRecords - digestsTranslatedByOpenAI
  reductionPct: number;
  pushSucceeded: number;
  pushFailed: number;
  pushStats: PushStats;
}

// ── Route handler ─────────────────────────────────────────────────────────────

interface RequestBody {
  shopifyDomain?: string;
  targetLocale?: string;
  sourceLocale?: string;
  model?: string;
  systemPrompt?: string;
  glossary?: string;
}

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawShop = body.shopifyDomain ?? "";
  const shop = normalizeShopifyAdminDomain(rawShop);
  if (!shop) {
    return NextResponse.json(
      { error: "Missing shopifyDomain" },
      { status: 400 },
    );
  }

  const targetLocale  = (body.targetLocale  ?? "en").trim() || "en";
  const sourceLocale  = (body.sourceLocale  ?? "ru").trim() || "ru";
  const model         = (body.model         ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const glossaryRaw   = body.glossary ?? "";

  // Build system prompt (same pipeline as /api/translate)
  let systemPrompt = (body.systemPrompt ?? DEFAULT_SYSTEM_PROMPT).trim() || DEFAULT_SYSTEM_PROMPT;
  const srcName = localeName(sourceLocale);
  const tgtName = localeName(targetLocale);
  systemPrompt = systemPrompt
    .replace(/\{\{source_language\}\}/gi, srcName)
    .replace(/\{\{target_language\}\}/gi, tgtName)
    .replace(/\{source_language\}/gi, srcName)
    .replace(/\{target_language\}/gi, tgtName);

  if (glossaryRaw.trim()) {
    const pairs = glossaryRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes("="))
      .map((l) => { const [s, ...r] = l.split("="); return `- ${s.trim()} => ${r.join("=").trim()}`; });
    if (pairs.length) {
      systemPrompt += "\n\nGlossary rules (apply to all fields):\n" + pairs.join("\n");
    }
  }

  let token: string;
  try {
    const resolved = await resolveShopifyAccessToken({
      shopifyDomain: shop,
      cookieHeader: req.headers.get("cookie"),
    });
    token = resolved.token;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token not found." },
      { status: 401 },
    );
  }

  const startMs = Date.now();
  const statsByType: Record<ResourceType, TypeStats> = {} as Record<ResourceType, TypeStats>;

  for (const resourceType of RESOURCE_TYPES) {
    console.info(`[translate-options] Fetching ${resourceType}…`);

    const pushStats = createPushStats();

    // ── 1. Fetch all nodes ─────────────────────────────────────────────────
    let nodes: FetchedNode[];
    try {
      nodes = await fetchAllNodes(shop, token, resourceType, targetLocale);
    } catch (err) {
      console.error(`[translate-options] Failed to fetch ${resourceType}:`, err);
      statsByType[resourceType] = {
        totalRecords: 0, uniqueDigests: 0, digestsAlreadyTranslated: 0,
        digestsTranslatedByOpenAI: 0, openAiCallsSaved: 0, reductionPct: 0,
        pushSucceeded: 0, pushFailed: 0, pushStats,
      };
      continue;
    }

    const totalRecords = nodes.length;
    console.info(`[translate-options] ${resourceType}: ${totalRecords} records fetched`);

    // ── 2. Build digest map ────────────────────────────────────────────────
    const digestMap = buildDigestMap(nodes);
    const uniqueDigests = digestMap.size;

    const entriesToTranslate: DigestEntry[] = [];
    const entriesWithExisting: DigestEntry[] = [];

    for (const entry of digestMap.values()) {
      if (entry.resourceIdsNeedingPush.length === 0) continue; // all already done
      if (entry.existingTranslation) {
        // We have a translation from another record sharing the same digest.
        // Push it to the remaining resourceIds without calling OpenAI.
        entriesWithExisting.push(entry);
      } else {
        entriesToTranslate.push(entry);
      }
    }

    const digestsAlreadyTranslated = entriesWithExisting.length;
    const digestsTranslatedByOpenAI = entriesToTranslate.length;

    console.info(
      `[translate-options] ${resourceType}: ${uniqueDigests} unique digests — ` +
      `${digestsAlreadyTranslated} reuse existing, ${digestsTranslatedByOpenAI} need OpenAI`
    );

    // ── 3. Translate unique digests (one batch OpenAI call) ────────────────
    try {
      await translateUniqueDigests(
        entriesToTranslate, model, systemPrompt, sourceLocale, targetLocale, shop,
      );
    } catch (err) {
      console.error(`[translate-options] OpenAI error for ${resourceType}:`, err);
    }

    // ── 4. Push to all resourceIds needing translation ─────────────────────
    const { pushSucceeded, pushFailed } = await pushAllForType(
      shop, token, digestMap, targetLocale, pushStats, resourceType,
    );

    // ── 5. Log reduction stats ─────────────────────────────────────────────
    const openAiCallsSaved = totalRecords - digestsTranslatedByOpenAI;
    const reductionPct =
      totalRecords > 0 ? Math.round((openAiCallsSaved / totalRecords) * 100) : 0;

    console.info(
      `[translate-options] ${resourceType} dedup: ` +
      `${digestsTranslatedByOpenAI} unique digests translated instead of ${totalRecords} records ` +
      `(${reductionPct}% reduction). Push: ${pushSucceeded} ok, ${pushFailed} failed.`
    );

    statsByType[resourceType] = {
      totalRecords,
      uniqueDigests,
      digestsAlreadyTranslated,
      digestsTranslatedByOpenAI,
      openAiCallsSaved,
      reductionPct,
      pushSucceeded,
      pushFailed,
      pushStats,
    };
  }

  const elapsedMs = Date.now() - startMs;

  return NextResponse.json({
    shop,
    targetLocale,
    elapsedMs,
    stats: statsByType,
  });
}
