import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkKey(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_SUPPORT_KEY;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

// ── GET /api/internal/support ─────────────────────────────────────────────────
// ?shop=<domain>  → detailed view for one shop
// (no shop param) → list all shops with summary
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!checkKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shop = req.nextUrl.searchParams.get("shop");

  if (shop) {
    return getShopDetail(shop);
  }
  return getShopList();
}

// ── Shop list ─────────────────────────────────────────────────────────────────

async function getShopList() {
  const { data: stores, error } = await supabase
    .from("stores")
    .select("shop_domain, installed_at, access_token")
    .order("installed_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // For each store get a quick backup summary
  const shopDomains = (stores ?? []).map((s: { shop_domain: string }) => s.shop_domain);
  const { data: captureCounts } = await supabase
    .from("backup_captures")
    .select("shop_domain, resource_type")
    .in("shop_domain", shopDomains);

  const capturesByShop: Record<string, number> = {};
  for (const c of captureCounts ?? []) {
    capturesByShop[c.shop_domain] = (capturesByShop[c.shop_domain] ?? 0) + 1;
  }

  const shops = (stores ?? []).map((s: { shop_domain: string; installed_at: string; access_token: string | null }) => ({
    shop_domain:      s.shop_domain,
    installed_at:     s.installed_at,
    token_connected:  !!s.access_token,
    backup_types_captured: capturesByShop[s.shop_domain] ?? 0,
  }));

  return NextResponse.json({ shops });
}

// ── Shop detail ───────────────────────────────────────────────────────────────

async function getShopDetail(shop: string) {
  // Store row
  const { data: storeRow } = await supabase
    .from("stores")
    .select("shop_domain, installed_at, access_token")
    .eq("shop_domain", shop)
    .maybeSingle();

  // Backup captures (which resource types are marked as done)
  const { data: captures } = await supabase
    .from("backup_captures")
    .select("resource_type, locale, created_at")
    .eq("shop_domain", shop)
    .order("created_at", { ascending: false });

  // Backup counts by resource type (Supabase doesn't have COUNT via anon easily,
  // so we fetch the distinct resource_id + resource_type rows up to 1000)
  const { data: backupRows } = await supabase
    .from("backups")
    .select("resource_id, resource_type, locale, backed_up_at")
    .eq("shop_domain", shop)
    .order("backed_up_at", { ascending: false })
    .limit(1000);

  // Aggregate: count unique resource_ids per type
  const byType: Record<string, { resourceIds: Set<string>; lastDate: string }> = {};
  for (const row of backupRows ?? []) {
    if (!byType[row.resource_type]) {
      byType[row.resource_type] = { resourceIds: new Set(), lastDate: row.backed_up_at };
    }
    byType[row.resource_type].resourceIds.add(row.resource_id);
    if (row.backed_up_at > byType[row.resource_type].lastDate) {
      byType[row.resource_type].lastDate = row.backed_up_at;
    }
  }

  const backupSummary = Object.entries(byType).map(([type, v]) => ({
    resource_type:   type,
    resource_count:  v.resourceIds.size,
    last_backed_up:  v.lastDate,
  }));

  // Recent backed-up resource IDs (for restore UI) — sample per type
  const sampleResourceIds: Record<string, Array<{ resource_id: string; backed_up_at: string }>> = {};
  for (const row of backupRows ?? []) {
    if (!sampleResourceIds[row.resource_type]) sampleResourceIds[row.resource_type] = [];
    const arr = sampleResourceIds[row.resource_type];
    if (arr.length < 5 && !arr.find((x) => x.resource_id === row.resource_id)) {
      arr.push({ resource_id: row.resource_id, backed_up_at: row.backed_up_at });
    }
  }

  // OpenAI usage summary
  const { data: usageRows } = await supabase
    .from("openai_usage_logs")
    .select("model, prompt_tokens, completion_tokens, total_tokens, estimated_cost, request_type, created_at")
    .eq("shop_domain", shop)
    .order("created_at", { ascending: false })
    .limit(500);

  const usageSummary = (() => {
    if (!usageRows?.length) return null;
    const modelSet = new Set<string>();
    let totalRequests = 0, totalPrompt = 0, totalCompletion = 0, totalTokens = 0, totalCost = 0;
    for (const r of usageRows) {
      modelSet.add(r.model);
      totalRequests++;
      totalPrompt     += r.prompt_tokens     ?? 0;
      totalCompletion += r.completion_tokens ?? 0;
      totalTokens     += r.total_tokens      ?? 0;
      totalCost       += Number(r.estimated_cost ?? 0);
    }
    return {
      total_requests:          totalRequests,
      total_prompt_tokens:     totalPrompt,
      total_completion_tokens: totalCompletion,
      total_tokens:            totalTokens,
      total_estimated_cost:    totalCost,
      models_used:             [...modelSet],
      last_used_at:            usageRows[0]?.created_at ?? null,
    };
  })();

  // Logs — select known columns only (metadata may not be in schema yet)
  const { data: logs } = await supabase
    .from("logs")
    .select("id, shop_domain, action, status, message, created_at")
    .eq("shop_domain", shop)
    .order("created_at", { ascending: false })
    .limit(30);

  return NextResponse.json({
    store: storeRow
      ? {
          shop_domain:     storeRow.shop_domain,
          installed_at:    storeRow.installed_at,
          token_connected: !!storeRow.access_token,
          // TODO: add source_locale / target_locale columns to stores table (populated on OAuth)
          source_locale:   null,
          target_locale:   null,
        }
      : null,
    backups: {
      summary:     backupSummary,
      captures:    captures ?? [],
      sample_ids:  sampleResourceIds,
    },
    // TODO: populate from a sync_logs table (does not exist yet)
    sync: {
      last_sync_at:     null,
      last_sync_status: null,
      counts_by_type:   null,
      _placeholder:     true,
    },
    usage: usageSummary,
    logs: logs ?? [],
  });
}
