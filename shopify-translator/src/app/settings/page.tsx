"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, AVAILABLE_MODELS } from "@/lib/translationDefaults";
import { loadSettings, saveSettings } from "@/lib/settingsStorage";
import {
  languageLabelForCode,
  normalizeLocaleCode,
} from "@/lib/languageDisplay";
import type { ShopLocale } from "@/app/api/shopify/locales/route";

// ── Per-shop target locale persistence ────────────────────────────────────────

function shopLocaleKey(shop: string) {
  return `localeflow_target_locale_${shop}`;
}
function loadPerShopLocale(shop: string): string | null {
  if (typeof window === "undefined" || !shop) return null;
  return localStorage.getItem(shopLocaleKey(shop));
}
function savePerShopLocale(shop: string, locale: string) {
  if (typeof window === "undefined" || !shop) return;
  localStorage.setItem(shopLocaleKey(shop), locale);
}

// ── Glossary helpers ──────────────────────────────────────────────────────────

type GlossaryRow = { source: string; target: string };

function rowsToGlossaryString(rows: GlossaryRow[]): string {
  const seen = new Set<string>();
  return rows
    .map((r) => ({ source: r.source.trim(), target: r.target.trim() }))
    .filter((r) => r.source || r.target)
    .filter((r) => {
      if (r.source && seen.has(r.source)) return false;
      if (r.source) seen.add(r.source);
      return true;
    })
    .map((r) => `${r.source} = ${r.target}`)
    .join("\n");
}

function glossaryStringToRows(str: string): GlossaryRow[] {
  if (!str.trim()) return [{ source: "", target: "" }];
  const rows: GlossaryRow[] = str.split("\n").flatMap((line) => {
    const eqIdx = line.indexOf(" = ");
    if (eqIdx === -1) {
      const s = line.trim();
      return s ? [{ source: s, target: "" }] : [];
    }
    return [{ source: line.slice(0, eqIdx).trim(), target: line.slice(eqIdx + 3).trim() }];
  });
  return [...rows, { source: "", target: "" }];
}

export default function SettingsPage() {
  const router = useRouter();
  const [model, setModel]               = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [glossaryRows, setGlossaryRows] = useState<GlossaryRow[]>([{ source: "", target: "" }]);
  const [sourceLanguage, setSourceLanguage] = useState("ru");
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [shopifyDomain, setShopifyDomain]             = useState("");
  const [shopifyClientId, setShopifyClientId]         = useState("");
  const [shopifyClientSecret, setShopifyClientSecret] = useState("");
  const [tokenExpiry, setTokenExpiry]                 = useState(0);
  /** Server-side JSON store has a token for this shop (OAuth or dev test). */
  const [serverConnected, setServerConnected]       = useState(false);
  const [testing, setTesting]                         = useState(false);
  const [testResult, setTestResult]                   = useState<"ok"|"error"|null>(null);
  const [testMessage, setTestMessage]                 = useState("");
  /** Shopify `shopLocales.name` for primary locale when connected (optional). */
  const [sourceLabelFromShop, setSourceLabelFromShop] = useState<string | null>(null);
  const [sourceLocaleLoading, setSourceLocaleLoading] = useState(false);
  /** Non-primary locales fetched from store's shopLocales API. */
  const [shopLocales, setShopLocales] = useState<ShopLocale[]>([]);
  const [shopLocalesLoading, setShopLocalesLoading] = useState(false);
  const [shopLocalesFetched, setShopLocalesFetched] = useState(false);
  const [shopLocalesError, setShopLocalesError] = useState<string | null>(null);
  const [showHreflangOverlay, setShowHreflangOverlay] = useState(false);
  const [hreflangRecheckTick, setHreflangRecheckTick] = useState(0);
  const [hreflangRecheckLoading, setHreflangRecheckLoading] = useState(false);
  const [hreflangCopied, setHreflangCopied] = useState(false);
  const [saved, setSaved]                             = useState(false);
  const [isDefault, setIsDefault]                     = useState(true);
  const [isDirty, setIsDirty]                         = useState(false);
  // Snapshot of values as they were last loaded from / saved to localStorage.
  // isDirty = current state differs from this snapshot.
  const savedSnapshot = useRef<{
    model: string; systemPrompt: string; glossary: string;
    sourceLanguage: string; targetLanguage: string;
    shopifyDomain: string; shopifyClientId: string; shopifyClientSecret: string;
  } | null>(null);

  async function refreshServerConnection(domain: string) {
    const d = domain.trim();
    if (!d) {
      setServerConnected(false);
      return;
    }
    try {
      const res = await fetch(`/api/shopify/connection?domain=${encodeURIComponent(d)}`);
      const data = (await res.json()) as { connected?: boolean };
      setServerConnected(!!data.connected);
    } catch {
      setServerConnected(false);
    }
  }

  useEffect(() => {
    const s = loadSettings();
    setModel(s.model);
    setSystemPrompt(s.systemPrompt);
    setGlossaryRows(glossaryStringToRows(s.glossary || ""));
    setSourceLanguage(s.sourceLanguage || "ru");
    setTargetLanguage(s.targetLanguage || "en");
    setShopifyDomain(s.shopifyDomain || "");
    setShopifyClientId(s.shopifyClientId || "");
    setShopifyClientSecret(s.shopifyClientSecret || "");
    setTokenExpiry(s.shopifyTokenExpiry || 0);
    setIsDefault(
      s.systemPrompt === DEFAULT_SYSTEM_PROMPT &&
      s.model === DEFAULT_MODEL &&
      (s.glossary ?? "") === ""
    );

    void refreshServerConnection(s.shopifyDomain || "");
    // Snapshot what we just loaded — the change-watcher compares against this
    savedSnapshot.current = {
      model: s.model,
      systemPrompt: s.systemPrompt,
      glossary: s.glossary || "",
      sourceLanguage: s.sourceLanguage || "ru",
      targetLanguage: s.targetLanguage || "en",
      shopifyDomain: s.shopifyDomain || "",
      shopifyClientId: s.shopifyClientId || "",
      shopifyClientSecret: s.shopifyClientSecret || "",
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("shopify_oauth") === "ok") {
      const shop = params.get("shop") ?? "";
      if (shop) {
        setShopifyDomain(shop);
        // Persist shop domain immediately so sync/push routes can use it
        const s = loadSettings();
        saveSettings({ ...s, shopifyDomain: shop });
      }
      setTestResult("ok");
      setTestMessage("OAuth completed — your store is now connected.");
      window.history.replaceState({}, "", "/settings");
      void refreshServerConnection(shop || loadSettings().shopifyDomain || "");
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshServerConnection(shopifyDomain);
    }, 400);
    return () => clearTimeout(t);
  }, [shopifyDomain]);

  useEffect(() => {
    if (!serverConnected) {
      setSourceLabelFromShop(null);
      setSourceLocaleLoading(false);
      return;
    }
    const domain = shopifyDomain.trim();
    if (!domain) return;

    let cancelled = false;
    setSourceLocaleLoading(true);

    fetch(`/api/shopify/primary-locale?shop=${encodeURIComponent(domain)}`)
      .then(async (res) => {
        const data = (await res.json()) as {
          primaryLocale?: string;
          primaryLocaleName?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        return data;
      })
      .then((data) => {
        if (cancelled || !data.primaryLocale) return;
        const code = normalizeLocaleCode(data.primaryLocale);
        setSourceLanguage(code);
        setSourceLabelFromShop(data.primaryLocaleName ?? null);
        const s = loadSettings();
        saveSettings({ ...s, sourceLanguage: code });
        if (savedSnapshot.current) {
          savedSnapshot.current = { ...savedSnapshot.current, sourceLanguage: code };
        }
      })
      .catch(() => {
        /* keep languages from localStorage */
      })
      .finally(() => {
        if (!cancelled) setSourceLocaleLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serverConnected, shopifyDomain]);

  // Fetch non-primary locales from the store when connected
  useEffect(() => {
    if (!serverConnected) {
      setShopLocales([]);
      setShopLocalesFetched(false);
      setShopLocalesError(null);
      return;
    }
    const domain = shopifyDomain.trim();
    if (!domain) return;

    let cancelled = false;
    setShopLocalesLoading(true);
    setShopLocalesError(null);

    const localesUrl = `/api/shopify/locales?shop=${encodeURIComponent(domain)}${hreflangRecheckTick > 0 ? "&nocache=1" : ""}`;
    fetch(localesUrl)
      .then(async (res) => {
        // Route always returns 200 with { locales, error? }
        const data = (await res.json()) as { locales?: ShopLocale[]; error?: string };
        if (data.error) {
          if (!cancelled) setShopLocalesError(data.error);
        }
        return data.locales ?? [];
      })
      .then((all) => {
        if (cancelled) return;
        const nonPrimary = all.filter((l) => !l.primary);
        // Keep ALL non-primary locales in state (hreflang needs unpublished ones to flag issues)
        setShopLocales(nonPrimary);
        setShopLocalesFetched(true);

        // Auto-select: only consider PUBLISHED locales as valid targets
        const publishedNonPrimary = nonPrimary.filter((l) => l.published);
        const saved = loadPerShopLocale(domain);
        const savedIsUnpublished = !!saved && nonPrimary.some((l) => l.locale === saved && !l.published);
        const savedValid = saved && publishedNonPrimary.some((l) => l.locale === saved);
        if (savedValid) {
          setTargetLanguage(normalizeLocaleCode(saved!));
        } else if (savedIsUnpublished) {
          // Stale saved locale is now unpublished — clear it so the empty state shows
          setTargetLanguage("");
          savePerShopLocale(domain, "");
        } else if (publishedNonPrimary.length === 1) {
          const code = normalizeLocaleCode(publishedNonPrimary[0].locale);
          setTargetLanguage(code);
          savePerShopLocale(domain, code);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setShopLocalesError(err instanceof Error ? err.message : "Failed to load languages");
          setShopLocalesFetched(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setShopLocalesLoading(false);
          setHreflangRecheckLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [serverConnected, shopifyDomain, hreflangRecheckTick]);

  useEffect(() => {
    const glossaryStr = rowsToGlossaryString(glossaryRows);
    setIsDefault(
      systemPrompt === DEFAULT_SYSTEM_PROMPT &&
      model === DEFAULT_MODEL &&
      glossaryStr.trim() === "" &&
      sourceLanguage === "ru" &&
      targetLanguage === "en"
    );
    const snap = savedSnapshot.current;
    if (!snap) return; // snapshot not yet populated (still in initial load)
    const changed =
      model !== snap.model ||
      systemPrompt !== snap.systemPrompt ||
      glossaryStr !== snap.glossary ||
      sourceLanguage !== snap.sourceLanguage ||
      targetLanguage !== snap.targetLanguage ||
      shopifyDomain !== snap.shopifyDomain ||
      shopifyClientId !== snap.shopifyClientId ||
      shopifyClientSecret !== snap.shopifyClientSecret;
    setIsDirty(changed);
    if (changed) setSaved(false);
  }, [model, systemPrompt, glossaryRows, sourceLanguage, targetLanguage, shopifyDomain, shopifyClientId, shopifyClientSecret]);

  const tokenValid = serverConnected;

  function handleSave() {
    const glossaryStr = rowsToGlossaryString(glossaryRows);
    const s = loadSettings();
    saveSettings({
      ...s,
      model, systemPrompt,
      glossary: glossaryStr,
      sourceLanguage: normalizeLocaleCode(sourceLanguage || "ru"),
      targetLanguage: normalizeLocaleCode(targetLanguage || "en"),
      shopifyDomain, shopifyClientId, shopifyClientSecret,
    });
    savedSnapshot.current = {
      model, systemPrompt, glossary: glossaryStr,
      sourceLanguage: normalizeLocaleCode(sourceLanguage || "ru"),
      targetLanguage: normalizeLocaleCode(targetLanguage || "en"),
      shopifyDomain, shopifyClientId, shopifyClientSecret,
    };
    setIsDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function handleReset() {
    if (!confirm("Reset prompt, model, glossary, and language pair to factory defaults?")) return;
    setModel(DEFAULT_MODEL);
    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    setGlossaryRows([{ source: "", target: "" }]);
    setSourceLanguage("ru");
    setSourceLabelFromShop(null);
    setTargetLanguage("en");
    const s = loadSettings();
    saveSettings({ ...s, model: DEFAULT_MODEL, systemPrompt: DEFAULT_SYSTEM_PROMPT, glossary: "", sourceLanguage: "ru", targetLanguage: "en" });
    savedSnapshot.current = {
      model: DEFAULT_MODEL, systemPrompt: DEFAULT_SYSTEM_PROMPT, glossary: "",
      sourceLanguage: "ru", targetLanguage: "en",
      shopifyDomain, shopifyClientId, shopifyClientSecret,
    };
    setIsDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function handleTestConnection() {
    if (!shopifyDomain || !shopifyClientId || !shopifyClientSecret) return;
    setTesting(true);
    setTestResult(null);
    setTestMessage("");
    try {
      const res = await fetch("/api/shopify/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopifyDomain, shopifyClientId, shopifyClientSecret }),
      });
      const data = await res.json();
      if (!res.ok) {
        const extra =
          Array.isArray(data.granted_scopes) && data.granted_scopes.length
            ? ` Granted on token: ${data.granted_scopes.join(", ")}.`
            : "";
        throw new Error((data.error ?? "Failed") + extra);
      }

      const expiry = Date.now() + (data.expires_in ?? 86400) * 1000;
      setTokenExpiry(expiry);
      const s = loadSettings();
      saveSettings({
        ...s,
        shopifyDomain,
        shopifyClientId,
        shopifyClientSecret,
        shopifyAccessToken: "",
        shopifyTokenExpiry: 0,
      });
      setServerConnected(true);
      void refreshServerConnection(shopifyDomain);
      setTestResult("ok");
      const scopeNote =
        Array.isArray(data.granted_scopes) && data.granted_scopes.length
          ? ` Scopes: ${data.granted_scopes.join(", ")}.`
          : "";
      setTestMessage(
        `Token stored on the server (dev / custom app).${scopeNote} Expires ~${new Date(expiry).toLocaleString()}.`
      );
    } catch (e) {
      setTestResult("error");
      setTestMessage(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Remove the Shopify access token from this server?")) return;
    if (shopifyDomain.trim()) {
      try {
        await fetch(`/api/shopify/connection?domain=${encodeURIComponent(shopifyDomain.trim())}`, {
          method: "DELETE",
        });
      } catch {
        /* ignore */
      }
    }
    setTokenExpiry(0);
    setServerConnected(false);
    const s = loadSettings();
    saveSettings({ ...s, shopifyAccessToken: "", shopifyTokenExpiry: 0 });
  }

  function handleGlossaryChange(idx: number, field: "source" | "target", value: string) {
    const updated = glossaryRows.map((r, i) => (i === idx ? { ...r, [field]: value } : r));
    const last = updated[updated.length - 1];
    if (last.source.trim() || last.target.trim()) {
      updated.push({ source: "", target: "" });
    }
    setGlossaryRows(updated);
  }

  function handleGlossaryRemove(idx: number) {
    const updated = glossaryRows.filter((_, i) => i !== idx);
    const last = updated[updated.length - 1];
    if (!last || last.source.trim() || last.target.trim()) {
      updated.push({ source: "", target: "" });
    }
    setGlossaryRows(updated);
  }

  const [promptOpen, setPromptOpen] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(systemPrompt);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1500);
    } catch { /* ignore */ }
  }

  const promptLines = systemPrompt.split("\n").length;
  const glossaryStr = rowsToGlossaryString(glossaryRows);
  const ruleCount   = glossaryStr.split("\n").filter((l) => l.trim()).length;
  // Preview: first non-empty line, truncated to 80 chars
  const promptPreview = systemPrompt.split("\n").find((l) => l.trim()) ?? "";
  const promptPreviewTruncated = promptPreview.length > 80 ? promptPreview.slice(0, 80) + "…" : promptPreview;

  // Only published non-primary locales are valid translation targets
  const publishedShopLocales = shopLocales.filter((l) => l.published);

  return (
    <div className="min-h-screen bg-slate-50 overflow-x-hidden">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-screen-lg mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-y-2 gap-x-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <span className="text-gray-200">|</span>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <h1 className="text-lg font-bold text-gray-900">Translation Settings</h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!isDefault && (
              <button
                onClick={handleReset}
                className="px-3 py-2 text-sm text-gray-500 hover:text-red-600 hover:bg-red-50 border border-gray-200 hover:border-red-200 rounded-lg transition-all"
              >
                Reset to defaults
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!isDirty && !saved}
              className={`px-5 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm ${
                saved
                  ? "bg-green-600 text-white cursor-default"
                  : isDirty
                  ? "bg-indigo-600 text-white hover:bg-indigo-700"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed shadow-none"
              }`}
            >
              {saved ? (
                <span className="flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Saved
                </span>
              ) : (
                "Save"
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-screen-lg mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* 1. Translation Settings — model + language pair */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">Translation Settings</h2>
            <p className="text-xs text-gray-500 mt-0.5">Model and languages used for every translation request</p>
          </div>
          <div className="px-5 py-4 space-y-6">
            <div>
              <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">Model</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {AVAILABLE_MODELS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setModel(m.value)}
                    className={`flex flex-col items-start px-3 py-3 rounded-lg border text-left transition-all ${
                      model === m.value
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm"
                        : "border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700"
                    }`}
                  >
                    <span className="font-mono text-sm font-semibold">{m.value}</span>
                    <span className="text-xs text-gray-500 mt-0.5 leading-tight">{m.label.split("(")[1]?.replace(")", "") || ""}</span>
                  </button>
                ))}
              </div>
              {model === "gpt-4o-mini" && (
                <p className="mt-3 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Mini model is faster and cheaper but may produce less accurate HTML structure preservation.
                </p>
              )}
              {(model === "gpt-4.1" || model === "gpt-4.1-mini") && (
                <p className="mt-3 text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  GPT-4.1 is the latest model. Verify it is available in your OpenAI account before using.
                </p>
              )}
            </div>

            <div className="border-t border-gray-100 pt-5">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Store languages
                </h3>
                {serverConnected && (
                  <span className="text-xs text-gray-400">Detected from Shopify</span>
                )}
              </div>

              {/* Not connected */}
              {!serverConnected && (
                <p className="text-xs text-gray-400 italic">
                  Connect your store above to detect language settings.
                </p>
              )}

              {/* Connected — language info row */}
              {serverConnected && (
                <div className="space-y-3">

                  {/* Source + target in one compact row */}
                  <div className="flex items-center gap-2 flex-wrap">

                    {/* Primary language pill */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">Translating from</span>
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-gray-100 text-gray-800 text-sm font-medium border border-gray-200">
                        {sourceLocaleLoading ? (
                          <span className="text-gray-400 text-xs">detecting…</span>
                        ) : (
                          <>
                            {serverConnected && sourceLabelFromShop
                              ? sourceLabelFromShop
                              : languageLabelForCode(sourceLanguage)}
                            <span className="text-gray-400 font-mono text-[11px]">{sourceLanguage}</span>
                          </>
                        )}
                      </span>
                    </div>

                    <span className="text-gray-300 text-base">→</span>

                    {/* Target language */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">into</span>

                      {shopLocalesLoading && (
                        <span className="text-xs text-gray-400 italic">loading…</span>
                      )}

                      {/* Single published locale — auto-detected, read-only */}
                      {!shopLocalesLoading && publishedShopLocales.length === 1 && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-800 text-sm font-medium border border-indigo-200">
                          {publishedShopLocales[0].name}
                          <span className="text-indigo-400 font-mono text-[11px]">{publishedShopLocales[0].locale}</span>
                        </span>
                      )}

                      {/* Multiple published locales — compact inline selector */}
                      {!shopLocalesLoading && publishedShopLocales.length > 1 && (
                        <select
                          id="target-language"
                          value={targetLanguage}
                          onChange={(e) => {
                            const v = normalizeLocaleCode(e.target.value);
                            if (v) {
                              setTargetLanguage(v);
                              savePerShopLocale(shopifyDomain.trim(), v);
                            }
                          }}
                          className="px-2.5 py-1 text-sm border border-indigo-200 rounded-md bg-indigo-50 text-indigo-800 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-400"
                        >
                          {publishedShopLocales.map((l) => (
                            <option key={l.locale} value={l.locale}>
                              {l.name} ({l.locale})
                            </option>
                          ))}
                        </select>
                      )}

                      {/* Not yet fetched — show stored value quietly */}
                      {!shopLocalesLoading && !shopLocalesFetched && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-gray-100 text-gray-600 text-sm font-medium border border-gray-200">
                          {languageLabelForCode(targetLanguage)}
                          <span className="text-gray-400 font-mono text-[11px]">{targetLanguage}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* ── Hreflang status ──────────────────────────────── */}
                  {(() => {
                    if (shopLocalesLoading || !shopLocalesFetched || shopLocales.length === 0) return null;
                    const allPublished = shopLocales.every((l) => l.published);
                    const isSimple = shopLocales.length === 1 && allPublished;
                    const hasIssues = !allPublished;

                    return (
                      <div className="flex items-center gap-2 text-sm">
                        {isSimple ? (
                          <span className="text-green-700">✅ Hreflang signals active for both languages</span>
                        ) : hasIssues ? (
                          <>
                            <span className="text-amber-700">⚠ Hreflang — issues detected</span>
                            <button
                              onClick={() => setShowHreflangOverlay(true)}
                              className="text-blue-600 hover:underline text-xs"
                            >
                              Learn more →
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="text-green-700">✅ Hreflang active</span>
                            <button
                              onClick={() => setShowHreflangOverlay(true)}
                              className="text-blue-600 hover:underline text-xs"
                            >
                              Learn more →
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })()}

                  {/* ── Hreflang overlay ─────────────────────────────── */}
                  {showHreflangOverlay && (() => {
                    const SNIPPET = `{% for locale in shop.published_locales %}
  <link rel="alternate" hreflang="{{ locale.iso_code }}"
        href="{{ request.origin }}{% if locale.primary == false %}/{{ locale.iso_code }}{% endif %}{{ request.path }}" />
{% endfor %}
<link rel="alternate" hreflang="x-default"
      href="{{ request.origin }}{{ request.path }}" />`;

                    const allPublished = shopLocales.every((l) => l.published);

                    return (
                      <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
                        onClick={() => setShowHreflangOverlay(false)}
                      >
                        <div
                          className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Header */}
                          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                            <span className="text-xs font-semibold tracking-widest text-gray-500 uppercase">Hreflang Status</span>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => {
                                  setHreflangRecheckLoading(true);
                                  setHreflangRecheckTick((t) => t + 1);
                                }}
                                disabled={hreflangRecheckLoading}
                                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
                              >
                                <span className={hreflangRecheckLoading ? "animate-spin inline-block" : ""}>↻</span>
                                {hreflangRecheckLoading ? "Checking…" : "Recheck"}
                              </button>
                              <button
                                onClick={() => setShowHreflangOverlay(false)}
                                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                                aria-label="Close"
                              >
                                ×
                              </button>
                            </div>
                          </div>

                          {/* Locale rows */}
                          <div className={`px-5 py-4 space-y-2.5 transition-opacity duration-200 ${hreflangRecheckLoading ? "opacity-40 pointer-events-none" : ""}`}>
                            {/* Source (primary) locale */}
                            <div className="flex items-start gap-2">
                              <span className="text-green-600 mt-0.5">✅</span>
                              <div>
                                <span className="text-sm font-medium text-gray-800">
                                  {sourceLabelFromShop || sourceLanguage.toUpperCase()} ({sourceLanguage})
                                </span>
                                <span className="ml-2 text-xs text-gray-400">Primary · Published</span>
                              </div>
                            </div>

                            {/* Target locales */}
                            {shopLocales.map((l) => (
                              <div key={l.locale} className="flex items-start gap-2">
                                <span className={`mt-0.5 ${l.published ? "text-green-600" : "text-amber-500"}`}>
                                  {l.published ? "✅" : "⚠ "}
                                </span>
                                <div>
                                  <span className="text-sm font-medium text-gray-800">
                                    {l.name} ({l.locale})
                                  </span>
                                  {l.published ? (
                                    <span className="ml-2 text-xs text-gray-400">Published</span>
                                  ) : (
                                    <div className="text-xs text-amber-700 mt-0.5">
                                      Unpublished →{" "}
                                      <a
                                        href="https://help.shopify.com/en/manual/markets/languages/managing-languages-in-shopify"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="underline"
                                      >
                                        Publish in Shopify Admin → Settings → Languages ↗
                                      </a>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}

                            {/* x-default */}
                            <div className="flex items-start gap-2">
                              <span className="text-amber-500 mt-0.5">⚠ </span>
                              <div>
                                <span className="text-sm font-medium text-gray-800">x-default</span>
                                <span className="ml-2 text-xs text-gray-400">Always verify manually in your theme</span>
                              </div>
                            </div>
                          </div>

                          {/* Summary line */}
                          {allPublished && !hreflangRecheckLoading && (
                            <div className="mx-5 mb-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                              All languages are published. Hreflang signals will work correctly once the theme snippet is in place.
                            </div>
                          )}

                          {/* Divider */}
                          <div className="mx-5 border-t border-gray-100 my-2" />

                          {/* What to check */}
                          <div className="px-5 pb-5 space-y-3">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">What to Check in Your Theme</p>
                            <ol className="text-sm text-gray-700 space-y-1 list-none pl-0">
                              <li><span className="text-gray-400 mr-1.5">1.</span>Open <strong>Online Store → Themes → Edit code</strong></li>
                              <li><span className="text-gray-400 mr-1.5">2.</span>Open <code className="bg-gray-100 rounded px-1 text-xs">theme.liquid</code></li>
                              <li><span className="text-gray-400 mr-1.5">3.</span>Search for <code className="bg-gray-100 rounded px-1 text-xs">hreflang</code> inside <code className="bg-gray-100 rounded px-1 text-xs">&lt;head&gt;</code></li>
                              <li><span className="text-gray-400 mr-1.5">4.</span>If missing, paste this snippet:</li>
                            </ol>

                            {/* Code block */}
                            <div className="relative">
                              <pre className="bg-gray-950 text-gray-100 rounded-lg text-xs p-4 overflow-x-auto leading-relaxed whitespace-pre">
                                <code>{SNIPPET}</code>
                              </pre>
                              <button
                                onClick={() => {
                                  void navigator.clipboard.writeText(SNIPPET).then(() => {
                                    setHreflangCopied(true);
                                    setTimeout(() => setHreflangCopied(false), 2000);
                                  });
                                }}
                                className="absolute top-2 right-2 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded px-2 py-1 transition-colors"
                              >
                                {hreflangCopied ? "Copied ✓" : "Copy"}
                              </button>
                            </div>

                            <p className="text-xs text-gray-400">
                              After pasting → save theme → come back and{" "}
                              <button
                                onClick={() => {
                                  setHreflangRecheckLoading(true);
                                  setHreflangRecheckTick((t) => t + 1);
                                }}
                                className="text-blue-600 hover:underline"
                              >
                                Recheck ↻
                              </button>
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}


                  {/* No published target locales */}
                  {!shopLocalesLoading && shopLocalesFetched && publishedShopLocales.length === 0 && !shopLocalesError && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                      {shopLocales.length > 0
                        ? <>Target language is added but not yet published. Publish it in <strong>Shopify Admin → Settings → Languages</strong>.</>
                        : <>No target language found. Add one in <strong>Shopify Admin → Settings → Languages</strong>.</>
                      }
                    </p>
                  )}

                  {/* Scope / API error */}
                  {shopLocalesError && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 flex items-start gap-1.5">
                      <span className="shrink-0">⚠</span>
                      <span>
                        {shopLocalesError.includes("read_locales")
                          ? <>Language access not granted — click <strong>Reconnect</strong> below to update permissions.</>
                          : shopLocalesError}
                      </span>
                    </p>
                  )}

                  {/* Subtle hint */}
                  <p className="text-xs text-gray-400">
                    Working language can also be chosen during sync on the main page.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 2. System prompt — collapsible */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {/* Header row — always visible */}
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-3">
            {/* Collapse toggle (chevron + title) */}
            <button
              type="button"
              onClick={() => setPromptOpen((v) => !v)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
            >
              <svg
                className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${promptOpen ? "rotate-90" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <h2 className="text-base font-semibold text-gray-900">System Prompt</h2>
              {!promptOpen && promptPreviewTruncated && (
                <span className="text-xs text-gray-400 font-mono truncate hidden sm:block">
                  {promptPreviewTruncated}
                </span>
              )}
            </button>

            {/* Right-side controls */}
            <div className="flex items-center gap-2 shrink-0">
              {promptOpen && (
                <span className="text-xs text-gray-400 font-mono tabular-nums hidden sm:block">
                  {promptLines} lines · {systemPrompt.length} chars
                </span>
              )}

              {/* Copy button — same pattern as RichTextEditor */}
              <button
                type="button"
                onClick={() => void handleCopyPrompt()}
                title="Copy prompt to clipboard"
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                  promptCopied
                    ? "bg-green-50 text-green-700 border-green-200"
                    : "bg-white text-gray-500 border-gray-200 hover:text-gray-700 hover:bg-gray-50"
                }`}
              >
                {promptCopied ? (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy
                  </>
                )}
              </button>

              {/* Show / Hide toggle */}
              <button
                type="button"
                onClick={() => setPromptOpen((v) => !v)}
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-gray-200 bg-white text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
              >
                {promptOpen ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {/* Expanded body */}
          {promptOpen && (
            <div className="p-4">
              {isDirty && (
                <div className="mb-3 flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  You have unsaved changes. Click "Save Settings" to apply.
                </div>
              )}
              <p className="text-xs text-gray-500 mb-3">Controls tone, formatting, and translation behavior</p>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={32}
                spellCheck={false}
                className="w-full px-4 py-3 text-sm font-mono bg-gray-950 text-green-400 border border-gray-800 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500 leading-relaxed"
                placeholder="Enter your system prompt…"
              />
            </div>
          )}
        </div>

        {/* 3. Glossary — dynamic table */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Glossary</h2>
              <p className="text-xs text-gray-400 mt-0.5">Terms that must always be translated a specific way</p>
            </div>
            <span className="text-xs text-gray-400 font-mono tabular-nums">
              {ruleCount} {ruleCount === 1 ? "rule" : "rules"}
            </span>
          </div>
          <div className="p-4">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_1fr_1.5rem] gap-2 mb-1.5 px-0.5">
              <span className="text-xs font-medium text-gray-500">Source</span>
              <span className="text-xs font-medium text-gray-500">Target</span>
              <span />
            </div>

            <div className="space-y-1.5">
              {glossaryRows.map((row, idx) => {
                const isLastRow  = idx === glossaryRows.length - 1;
                const srcTrimmed = row.source.trim();
                const isDuplicate =
                  !isLastRow &&
                  srcTrimmed !== "" &&
                  glossaryRows.some((r, i) => i !== idx && r.source.trim() === srcTrimmed);

                return (
                  <div key={idx} className="grid grid-cols-[1fr_1fr_1.5rem] gap-2 items-center">
                    <input
                      type="text"
                      value={row.source}
                      onChange={(e) => handleGlossaryChange(idx, "source", e.target.value)}
                      placeholder=""
                      spellCheck={false}
                      className={`px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-colors ${
                        isDuplicate
                          ? "border-red-300 bg-red-50 focus:ring-red-400"
                          : "border-gray-200 focus:border-indigo-300"
                      }`}
                    />
                    <input
                      type="text"
                      value={row.target}
                      onChange={(e) => handleGlossaryChange(idx, "target", e.target.value)}
                      placeholder=""
                      spellCheck={false}
                      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-300 transition-colors"
                    />
                    {isLastRow ? (
                      <span className="w-6" />
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleGlossaryRemove(idx)}
                        title="Remove rule"
                        className="w-6 h-6 flex items-center justify-center text-gray-300 hover:text-red-500 transition-colors rounded"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {ruleCount > 0 && (
              <p className="mt-3 text-xs text-gray-400">
                Injected into every translation prompt. Duplicate source entries are ignored.
              </p>
            )}
          </div>
        </div>

        {/* 4. Shopify Connection — maintenance */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">Shopify Connection</h2>
            <p className="text-xs text-gray-500 mt-0.5">OAuth access for sync and push</p>
          </div>
          <div className="px-5 py-4 space-y-4">
            {tokenValid ? (
              <p className="text-sm text-gray-700 flex items-center gap-2">
                <span className="text-green-600" aria-hidden>✅</span>
                <span>
                  Connected to <span className="font-mono font-medium">{shopifyDomain || "—"}</span>
                </span>
              </p>
            ) : (
              <>
                <p className="text-sm text-gray-600">Not connected. Enter your store domain, then connect.</p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">Store domain</label>
                  <input
                    type="text"
                    value={shopifyDomain}
                    onChange={(e) => setShopifyDomain(e.target.value.trim())}
                    placeholder="your-store.myshopify.com"
                    className="w-full max-w-md px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono placeholder-gray-300"
                  />
                </div>
              </>
            )}

            <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
              <button
                type="button"
                onClick={() => {
                  if (!shopifyDomain.trim()) {
                    setTestResult("error");
                    setTestMessage("Enter your store domain first.");
                    return;
                  }
                  window.location.href = `/api/auth/exit-iframe?shop=${encodeURIComponent(shopifyDomain.trim())}&return_to=/settings`;
                }}
                disabled={!shopifyDomain.trim()}
                className={`inline-flex items-center justify-center px-4 py-2.5 rounded-lg text-sm font-semibold transition-all border ${
                  !shopifyDomain.trim()
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200"
                    : "bg-white text-[#008060] border-[#008060]/40 hover:bg-[#008060]/5 shadow-sm"
                }`}
              >
                {tokenValid ? "Reconnect" : "Connect with Shopify"}
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={!tokenValid}
                className={`inline-flex items-center justify-center px-4 py-2.5 rounded-lg text-sm font-semibold border transition-all ${
                  !tokenValid
                    ? "bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                }`}
              >
                Clear token
              </button>
            </div>

            {testResult && (
              <div
                className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ${
                  testResult === "ok"
                    ? "bg-green-50 border-green-200 text-green-700"
                    : "bg-red-50 border-red-200 text-red-700"
                }`}
              >
                {testResult === "ok" ? (
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                {testMessage}
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
