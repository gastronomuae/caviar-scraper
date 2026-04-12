"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShopSummary {
  shop_domain: string;
  installed_at: string | null;
  token_connected: boolean;
  backup_types_captured: number;
}

interface BackupCapture {
  resource_type: string;
  locale: string;
  created_at: string;
}

interface BackupSummaryItem {
  resource_type: string;
  resource_count: number;
  last_backed_up: string;
}

interface SampleId {
  resource_id: string;
  backed_up_at: string;
}

interface ShopDetail {
  store: {
    shop_domain: string;
    installed_at: string | null;
    token_connected: boolean;
    source_locale: string | null;
    target_locale: string | null;
  } | null;
  backups: {
    summary: BackupSummaryItem[];
    captures: BackupCapture[];
    sample_ids: Record<string, SampleId[]>;
  };
  sync: { last_sync_at: string | null; last_sync_status: string | null; counts_by_type: null; _placeholder: boolean };
  usage: {
    total_requests:          number;
    total_prompt_tokens:     number;
    total_completion_tokens: number;
    total_tokens:            number;
    total_estimated_cost:    number;
    models_used:             string[];
    last_used_at:            string | null;
  } | null;
  logs: Record<string, unknown>[];
}

// ── Key gate ─────────────────────────────────────────────────────────────────

function useAuthKey() {
  const [key, setKey] = useState<string>("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = sessionStorage.getItem("internal_support_key") ?? "";
    if (stored) setKey(stored);
  }, []);

  function submit() {
    if (!input.trim()) { setError("Enter the support key"); return; }
    sessionStorage.setItem("internal_support_key", input.trim());
    setKey(input.trim());
    setError("");
  }

  function clear() {
    sessionStorage.removeItem("internal_support_key");
    setKey("");
    setInput("");
  }

  return { key, input, setInput, submit, error, clear };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, key: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

// ── Tiny UI primitives ────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-lg mb-4">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 rounded-t-lg">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      <span className="text-gray-500 w-40 shrink-0">{label}</span>
      <span className="text-gray-900 font-mono break-all">{value ?? <span className="text-gray-400 italic">—</span>}</span>
    </div>
  );
}

function Badge({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
      {text}
    </span>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
      ⚠ {label} — data not yet available (no backing table)
    </p>
  );
}

function fmt(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

// ── Restore modal ─────────────────────────────────────────────────────────────

function RestoreModal({
  shop,
  authKey,
  onClose,
}: {
  shop: string;
  authKey: string;
  onClose: () => void;
}) {
  const [resourceId, setResourceId] = useState("");
  const [locale, setLocale] = useState("en");
  const [stage, setStage] = useState<"form" | "confirm" | "loading" | "done" | "error">("form");
  const [result, setResult] = useState<{ restored: number; fields: string[]; warning?: string } | null>(null);
  const [errMsg, setErrMsg] = useState("");

  async function confirm() {
    setStage("loading");
    try {
      const data = await apiFetch<{ restored: number; fields: string[]; warning?: string }>(
        "/api/internal/restore",
        authKey,
        {
          method: "POST",
          body: JSON.stringify({ shopifyDomain: shop, resourceId: resourceId.trim(), locale: locale.trim() }),
        },
      );
      setResult(data);
      setStage("done");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Unknown error");
      setStage("error");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold mb-4">Restore backup</h2>

        {stage === "form" && (
          <>
            <p className="text-sm text-gray-600 mb-4">
              Pushes the backed-up translations back to Shopify for this resource.
            </p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Resource ID (GID)</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono mb-3 focus:outline-none focus:border-blue-400"
              placeholder="gid://shopify/Product/123456"
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
            />
            <label className="block text-xs font-medium text-gray-600 mb-1">Locale</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono mb-4 focus:outline-none focus:border-blue-400"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            />
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">Cancel</button>
              <button
                onClick={() => setStage("confirm")}
                disabled={!resourceId.trim()}
                className="px-4 py-2 text-sm bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </>
        )}

        {stage === "confirm" && (
          <>
            <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-4 text-sm">
              <p className="font-medium text-amber-800 mb-1">⚠ Confirm restore</p>
              <p className="text-amber-700 mb-1">This will <strong>overwrite the current Shopify translation</strong> for:</p>
              <p className="font-mono text-xs break-all text-gray-700 mt-2">{resourceId}</p>
              <p className="text-xs text-gray-600 mt-1">Locale: <strong>{locale}</strong> · Shop: <strong>{shop}</strong></p>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setStage("form")} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">Back</button>
              <button onClick={confirm} className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700">
                Restore now
              </button>
            </div>
          </>
        )}

        {stage === "loading" && (
          <p className="text-sm text-gray-500 py-4 text-center">Restoring…</p>
        )}

        {stage === "done" && result && (
          <>
            <div className="bg-green-50 border border-green-200 rounded p-3 mb-4 text-sm">
              <p className="font-medium text-green-800">✓ Restored {result.restored} field(s)</p>
              <p className="text-green-700 text-xs mt-1">{result.fields.join(", ")}</p>
              {result.warning && <p className="text-amber-600 text-xs mt-2">⚠ {result.warning}</p>}
            </div>
            <div className="flex justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-900 text-white rounded">Done</button>
            </div>
          </>
        )}

        {stage === "error" && (
          <>
            <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">{errMsg}</div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setStage("form")} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">Back</button>
              <button onClick={onClose} className="px-4 py-2 text-sm bg-gray-900 text-white rounded">Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Shop detail panel ─────────────────────────────────────────────────────────

function ShopDetailPanel({ shop, authKey }: { shop: string; authKey: string }) {
  const [detail, setDetail] = useState<ShopDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showRestore, setShowRestore] = useState(false);
  const prevShop = useRef("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<ShopDetail>(`/api/internal/support?shop=${encodeURIComponent(shop)}`, authKey);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [shop, authKey]);

  useEffect(() => {
    if (prevShop.current !== shop) {
      prevShop.current = shop;
      void load();
    }
  }, [shop, load]);

  if (loading) return <div className="p-8 text-gray-400 text-sm">Loading…</div>;
  if (error) return <div className="p-8 text-red-500 text-sm">{error}</div>;
  if (!detail) return null;

  const { store, backups, sync, usage, logs } = detail;
  const totalBackedUpResources = backups.summary.reduce((s, x) => s + x.resource_count, 0);
  const lastBackupDate = backups.summary.reduce<string | null>((latest, x) => {
    if (!latest || x.last_backed_up > latest) return x.last_backed_up;
    return latest;
  }, null);

  return (
    <div className="p-6 overflow-y-auto h-full">
      {showRestore && (
        <RestoreModal shop={shop} authKey={authKey} onClose={() => { setShowRestore(false); void load(); }} />
      )}

      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold text-gray-900 font-mono">{shop}</h2>
        <button onClick={() => void load()} className="text-xs text-gray-400 hover:text-gray-700 border border-gray-200 rounded px-2 py-1">
          ↻ Refresh
        </button>
      </div>

      {/* A. Store info */}
      <Card title="Store Info">
        <Row label="Shop domain" value={store?.shop_domain} />
        <Row label="Token status" value={store ? <Badge ok={store.token_connected} text={store.token_connected ? "Connected" : "Missing"} /> : null} />
        <Row label="Installed at" value={fmt(store?.installed_at ?? null)} />
        <Row
          label="Languages"
          value={
            store?.source_locale
              ? `${store.source_locale} → ${store.target_locale}`
              : <span className="text-amber-500 text-xs">ru → en (from storeConfig — not stored per-shop yet)</span>
          }
        />
      </Card>

      {/* B. Backup info */}
      <Card title="Backup Info">
        {backups.summary.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No backups for this shop.</p>
        ) : (
          <>
            <Row label="Total resources" value={String(totalBackedUpResources)} />
            <Row label="Last backup" value={fmt(lastBackupDate)} />
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-100">
                    <th className="text-left pb-1 font-medium">Type</th>
                    <th className="text-right pb-1 font-medium">Resources</th>
                    <th className="text-right pb-1 font-medium">Last backed up</th>
                    <th className="text-right pb-1 font-medium">Captured</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.summary.map((row) => {
                    const cap = backups.captures.find((c) => c.resource_type === row.resource_type);
                    return (
                      <tr key={row.resource_type} className="border-b border-gray-50">
                        <td className="py-1 font-mono font-semibold text-gray-700">{row.resource_type}</td>
                        <td className="py-1 text-right text-gray-600">{row.resource_count}</td>
                        <td className="py-1 text-right text-gray-500">{fmt(row.last_backed_up)}</td>
                        <td className="py-1 text-right">
                          {cap ? <Badge ok text={fmt(cap.created_at) ?? "yes"} /> : <Badge ok={false} text="not marked" />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Sample resource IDs per type */}
            {Object.entries(backups.sample_ids).length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-gray-500 mb-2">Sample resource IDs (for restore)</p>
                {Object.entries(backups.sample_ids).map(([type, ids]) => (
                  <div key={type} className="mb-3">
                    <p className="text-xs font-semibold text-gray-600 mb-1">{type}</p>
                    {ids.map((item) => (
                      <div key={item.resource_id} className="flex items-center gap-2 py-0.5">
                        <span className="font-mono text-xs text-gray-500 truncate flex-1">{item.resource_id}</span>
                        <span className="text-xs text-gray-400 shrink-0">{fmt(item.backed_up_at)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-gray-100 flex gap-2">
              <button
                onClick={() => setShowRestore(true)}
                className="px-3 py-1.5 text-xs font-medium bg-amber-500 text-white rounded hover:bg-amber-600"
              >
                Restore by resource ID…
              </button>
              <button
                disabled
                title="Restore by type — not yet implemented"
                className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-400 rounded cursor-not-allowed"
              >
                Restore by type (soon)
              </button>
            </div>
          </>
        )}
      </Card>

      {/* C. Sync info */}
      <Card title="Sync Info">
        {sync._placeholder ? (
          <Placeholder label="Sync logs table does not exist yet — add sync_logs table to enable" />
        ) : (
          <>
            <Row label="Last sync" value={fmt(sync.last_sync_at)} />
            <Row label="Status" value={sync.last_sync_status} />
          </>
        )}
      </Card>

      {/* D. OpenAI Usage */}
      <Card title="OpenAI Usage">
        {!usage ? (
          <p className="text-sm text-gray-400 italic">No translation requests recorded yet.</p>
        ) : (
          <>
            <Row label="Total requests"      value={usage.total_requests.toLocaleString()} />
            <Row label="Prompt tokens"       value={usage.total_prompt_tokens.toLocaleString()} />
            <Row label="Completion tokens"   value={usage.total_completion_tokens.toLocaleString()} />
            <Row label="Total tokens"        value={usage.total_tokens.toLocaleString()} />
            <Row
              label="Estimated cost"
              value={
                <span className="font-semibold text-emerald-700">
                  ${usage.total_estimated_cost.toFixed(4)}
                </span>
              }
            />
            <Row label="Models used"  value={usage.models_used.join(", ")} />
            <Row label="Last request" value={fmt(usage.last_used_at)} />
          </>
        )}
      </Card>

      {/* E. Logs */}
      <Card title="Recent Logs">
        {logs.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No log entries yet. Logs appear after syncs, pushes, restores, or errors.</p>
        ) : (
          <div className="space-y-1">
            {logs.map((log: Record<string, unknown>, i: number) => {
              const status = String(log.status ?? "");
              const statusColor =
                status === "error" ? "text-red-600 bg-red-50 border-red-200"
                : status === "warn" ? "text-yellow-700 bg-yellow-50 border-yellow-200"
                : "text-green-700 bg-green-50 border-green-200";
              const ts = log.created_at
                ? new Date(String(log.created_at)).toLocaleString()
                : "";
              return (
                <div key={i} className={`flex items-start gap-2 rounded border px-3 py-2 text-xs ${statusColor}`}>
                  <span className="font-mono shrink-0 opacity-60">{ts}</span>
                  <span className="font-semibold shrink-0">{String(log.action ?? "")}</span>
                  <span className="flex-1 truncate">{String(log.message ?? "")}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function InternalSupportPage() {
  const auth = useAuthKey();
  const [shops, setShops] = useState<ShopSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selectedShop, setSelectedShop] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");

  // Load shop list when key is set
  useEffect(() => {
    if (!auth.key) return;
    apiFetch<{ shops: ShopSummary[] }>("/api/internal/support", auth.key)
      .then((d) => {
        setShops(d.shops);
        if (d.shops.length > 0 && !selectedShop) setSelectedShop(d.shops[0].shop_domain);
        setLoadError("");
      })
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : "Failed to load shops");
        auth.clear();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.key]);

  const filteredShops = shops.filter((s) =>
    s.shop_domain.toLowerCase().includes(search.toLowerCase()),
  );

  // ── Key gate ──────────────────────────────────────────────────────────────
  if (!auth.key) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-8 w-full max-w-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Internal tool</p>
          <h1 className="text-lg font-semibold text-gray-900 mb-5">Support Dashboard</h1>
          {(auth.error || loadError) && (
            <p className="text-sm text-red-600 mb-3">{auth.error || loadError}</p>
          )}
          <input
            type="password"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:border-blue-400"
            placeholder="Support key"
            value={auth.input}
            onChange={(e) => auth.setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") auth.submit(); }}
            autoFocus
          />
          <button
            onClick={auth.submit}
            className="w-full py-2 text-sm font-medium bg-gray-900 text-white rounded hover:bg-gray-700"
          >
            Enter
          </button>
        </div>
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col overflow-x-hidden">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Internal</span>
          <span className="text-gray-300">·</span>
          <span className="text-sm font-semibold text-gray-900">Support Dashboard</span>
        </div>
        <button onClick={auth.clear} className="text-xs text-gray-400 hover:text-gray-700">
          Sign out
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden" style={{ height: "calc(100vh - 49px)" }}>
        {/* Sidebar */}
        <div className="w-64 shrink-0 bg-white border-r border-gray-200 flex flex-col">
          <div className="p-3 border-b border-gray-100">
            <input
              type="text"
              className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
              placeholder="Search shops…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredShops.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-6">No shops found</p>
            )}
            {filteredShops.map((s) => (
              <button
                key={s.shop_domain}
                onClick={() => setSelectedShop(s.shop_domain)}
                className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                  selectedShop === s.shop_domain ? "bg-blue-50 border-l-2 border-l-blue-500" : ""
                }`}
              >
                <p className="text-sm font-medium text-gray-800 truncate">{s.shop_domain}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.token_connected ? "bg-green-400" : "bg-red-400"}`} />
                  <span className="text-xs text-gray-400 truncate">
                    {s.backup_types_captured} type{s.backup_types_captured !== 1 ? "s" : ""} backed up
                    {s.installed_at ? ` · ${fmt(s.installed_at)}` : ""}
                  </span>
                </div>
              </button>
            ))}
          </div>
          <div className="p-3 border-t border-gray-100">
            <p className="text-xs text-gray-400">{shops.length} shop{shops.length !== 1 ? "s" : ""} total</p>
          </div>
        </div>

        {/* Main */}
        <div className="flex-1 overflow-y-auto">
          {selectedShop ? (
            <ShopDetailPanel shop={selectedShop} authKey={auth.key} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Select a shop from the sidebar
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
