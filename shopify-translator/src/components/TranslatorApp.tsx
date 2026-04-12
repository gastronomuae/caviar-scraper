"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import ProductTable, {
  type TableFilterState,
  type StatusFilter,
} from "@/components/ProductTable";
import ProductEditor from "@/components/ProductEditor";
import ThemeEditor from "@/components/ThemeEditor";
import MenuEditor from "@/components/MenuEditor";
import { parseTranslationCSV, deriveRecordStatus } from "@/utils/csvParser";
import { deriveTranslationStatus } from "@/utils/translationStatus";
import { translateFields } from "@/utils/openai";
import {
  TranslationRecord,
  TranslationField,
  RawTranslationRow,
  TranslateRequestField,
  TranslateRunResult,
} from "@/types";
import {
  shopifySyncRowsToTranslationRecords,
  mergeShopifySyncWithPrevious,
} from "@/utils/shopifySyncMapper";
import { loadSettings, saveSettings } from "@/lib/settingsStorage";
import { saveState, loadState } from "@/lib/storage";
import {
  readLastSyncAt,
  writeLastSyncAt,
  readLastSyncMeta,
  writeLastSyncMeta,
} from "@/utils/lastSyncAt";
import { fetchShopifySyncProductRows } from "@/utils/shopifySyncFetch";
import { reportClientError } from "@/utils/reportClientError";
import { isEffectivelyEmpty } from "@/utils/isEffectivelyEmpty";
import { explainNoFieldsToTranslate } from "@/utils/translateEligibility";
import { pushRecordToShopify, requireShopifyDomainForApi } from "@/utils/shopifyPushClient";
import { canPushTranslationRecord } from "@/utils/pushEligibility";
import { readSyncTypesFromStorage, syncTypeLabel } from "@/components/SyncToolbar";
import { readActiveLocale } from "@/lib/activeLocaleStorage";

interface PersistedState {
  records: TranslationRecord[];
  rawRows: RawTranslationRow[];
  filename: string;
}

/** Persists list filters across `/` ↔ `/p/...` navigations (each route remounts TranslatorApp). */
const SESSION_TABLE_FILTERS_KEY = "shopify-translator-table-filters-v1";
/** List scroll position when opening editor (restored on return to `/`). */
const SESSION_LIST_SCROLL_KEY = "shopify-translator-list-scroll-v1";

const DEFAULT_TABLE_FILTERS: TableFilterState = {
  typeFilter: "all",
  statusFilter: "all",
  localeFilter: "all",
  search: "",
  currentPage: 1,
  pushedToShopifyOnly: false,
};

const STATUS_FILTER_SET = new Set<StatusFilter>(["all", "new", "outdated", "partial", "translated"]);

function loadSessionTableFilters(): Partial<TableFilterState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_TABLE_FILTERS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<TableFilterState>;
  } catch {
    return null;
  }
}

function saveSessionTableFilters(state: TableFilterState): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_TABLE_FILTERS_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

function mergeSessionTableFilters(saved: Partial<TableFilterState> | null): TableFilterState {
  if (!saved) return { ...DEFAULT_TABLE_FILTERS };
  const statusFilter =
    saved.statusFilter != null && STATUS_FILTER_SET.has(saved.statusFilter)
      ? saved.statusFilter
      : DEFAULT_TABLE_FILTERS.statusFilter;

  let pushedToShopifyOnly = DEFAULT_TABLE_FILTERS.pushedToShopifyOnly;
  if (typeof saved.pushedToShopifyOnly === "boolean") {
    pushedToShopifyOnly = saved.pushedToShopifyOnly;
  } else {
    const legacy = saved as { pushFilter?: string };
    if (legacy.pushFilter === "pushed") pushedToShopifyOnly = true;
  }

  return {
    typeFilter: typeof saved.typeFilter === "string" ? saved.typeFilter : DEFAULT_TABLE_FILTERS.typeFilter,
    statusFilter,
    localeFilter: typeof saved.localeFilter === "string" ? saved.localeFilter : DEFAULT_TABLE_FILTERS.localeFilter,
    search: typeof saved.search === "string" ? saved.search : DEFAULT_TABLE_FILTERS.search,
    currentPage:
      typeof saved.currentPage === "number" && saved.currentPage >= 1
        ? Math.floor(saved.currentPage)
        : DEFAULT_TABLE_FILTERS.currentPage,
    pushedToShopifyOnly,
  };
}

/** Handle segment from URL path `/p/{handle}` (not root — avoids clashing with /settings etc.) */
function handleFromPathname(pathname: string | null): string | null {
  if (!pathname?.startsWith("/p/")) return null;
  const raw = pathname.slice(3).replace(/\/+$/, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function TranslatorApp({ shopDomain }: { shopDomain?: string } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const urlHandle = useMemo(() => handleFromPathname(pathname), [pathname]);

  const [records, setRecords] = useState<TranslationRecord[]>([]);
  const [rawRows, setRawRows] = useState<RawTranslationRow[]>([]);
  const [filename, setFilename] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isTranslatingBulk, setIsTranslatingBulk] = useState(false);
  const [isPushingBulk, setIsPushingBulk] = useState(false);
  const [pushingRowId, setPushingRowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  /** True when startup hydration found no local data + shop is known — triggers a silent auto-sync. */
  const [pendingAutoSync, setPendingAutoSync] = useState(false);
  const [selectionResetKey, setSelectionResetKey] = useState(0);
  /** Record IDs successfully pushed to Shopify in this browser session (not persisted) */
  const [sessionPushedIds, setSessionPushedIds] = useState<Set<string>>(() => new Set());
  const [tableFilters, setTableFilters] = useState<TableFilterState>(() => ({ ...DEFAULT_TABLE_FILTERS }));
  /** Shopify sync streaming progress (0–100), null when idle */
  const [syncProgressPct, setSyncProgressPct] = useState<number | null>(null);
  /** True once sync has been running for ≥15 s — prompts a "this may take a while" hint */
  const [syncSlowWarning, setSyncSlowWarning] = useState(false);
  /** Per-type completion badges shown while sync is active. */
  const [syncTypeProgress, setSyncTypeProgress] = useState<Array<{ resourceType: string; count: number }>>([]);
  /** ISO time from localStorage `lastSyncAt`, updated after a successful Shopify sync */
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  /** Friendly labels for the types used in the last successful sync. */
  const [lastSyncLabels, setLastSyncLabels] = useState<string[]>([]);
  const csvEmptyStateInputRef = useRef<HTMLInputElement>(null);
  // Ref always pointing to the latest records — lets handleLoadFromShopifySync
  // capture the pre-sync snapshot without adding `records` to the dep array
  // (which would recreate the callback on every incremental typeRows update).
  const recordsRef = useRef<TranslationRecord[]>(records);
  recordsRef.current = records;

  const persistTableFilters = useCallback((next: TableFilterState) => {
    setTableFilters(next);
    saveSessionTableFilters(next);
  }, []);

  useEffect(() => {
    const saved = loadSessionTableFilters();
    if (saved) {
      setTableFilters(mergeSessionTableFilters(saved));
    }
  }, []);

  useEffect(() => {
    setLastSyncAt(readLastSyncAt());
    const meta = readLastSyncMeta();
    setLastSyncLabels(meta?.labels ?? []);
  }, []);

  // When shop domain is supplied by the server (Shopify embedded open), persist it
  // to localStorage so requireShopifyDomainForApi() works on all devices without
  // the user manually entering it in Settings.
  useEffect(() => {
    if (!shopDomain) return;
    const current = loadSettings();
    if (current.shopifyDomain !== shopDomain) {
      saveSettings({ ...current, shopifyDomain: shopDomain });
    }
  }, [shopDomain]);

  useEffect(() => {
    // shopDomain is captured from the server-rendered prop (never changes after mount).
    // By the time this async callback resolves, the saveSettings effect above has already
    // written shopDomain to localStorage — safe for handleLoadFromShopifySync to read.
    const knownShop = shopDomain; // eslint-disable-line react-hooks/exhaustive-deps
    loadState<PersistedState>()
      .then((parsed) => {
        if (parsed) {
          setRecords(
            parsed.records.map((r) => ({
              ...r,
              isTranslating: false,
              translation_status: r.translation_status ?? deriveTranslationStatus(r.fields),
              reviewed: r.reviewed ?? false,
            }))
          );
          setRawRows(parsed.rawRows);
          setFilename(parsed.filename);
        } else {
          // IndexedDB is empty (fresh install, app restart, or storage wipe).
          //
          // Trigger auto-sync when the shop is known from Shopify's embedded
          // context (shopDomain server prop) OR when localStorage still holds a
          // lastSyncAt from a previous session.
          //
          // Both localStorage AND IndexedDB can be wiped by WKWebView when the
          // Shopify mobile app is killed, so we rely on the server-supplied
          // shopDomain as the primary "returning user" signal.
          //
          // Only fall back to the manual Sync button when neither signal is
          // present (e.g. user visits the URL directly without a Shopify session).
          if (knownShop || readLastSyncAt() !== null) {
            setPendingAutoSync(true);
          }
        }
      })
      .catch(() => {
        // IndexedDB read failed entirely (e.g. storage quota error, browser bug).
        // Fall through to the empty / first-launch UI rather than staying blank.
      })
      .finally(() => {
        setHydrated(true);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hydrated || records.length === 0) return;
    saveState({ records, rawRows, filename });
  }, [records, rawRows, filename, hydrated]);

  // Restore list scroll when returning from /p/... to `/` (saved in openEditor)
  useEffect(() => {
    if (!hydrated || pathname !== "/" || records.length === 0) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(SESSION_LIST_SCROLL_KEY);
    } catch {
      return;
    }
    if (raw == null) return;
    const y = parseInt(raw, 10);
    if (Number.isNaN(y) || y < 0) {
      try {
        sessionStorage.removeItem(SESSION_LIST_SCROLL_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    const apply = () => {
      const el = document.getElementById("shopify-translator-list-scroll");
      if (el) el.scrollTop = y;
    };
    apply();
    requestAnimationFrame(apply);
    try {
      sessionStorage.removeItem(SESSION_LIST_SCROLL_KEY);
    } catch {
      /* ignore */
    }
  }, [hydrated, pathname, records.length]);

  const selectedRecord = useMemo(() => {
    if (!urlHandle || records.length === 0) return null;
    return records.find((r) => r.handle === urlHandle) ?? null;
  }, [urlHandle, records]);

  const selectedIndex = useMemo(() => {
    if (!selectedRecord) return -1;
    return records.findIndex((r) => r.id === selectedRecord.id);
  }, [records, selectedRecord]);

  // Unknown handle on `/p/...` → error + redirect home
  useEffect(() => {
    if (!hydrated || !urlHandle || records.length === 0) return;
    if (selectedRecord) return;
    setError(`No record found for handle “${urlHandle}”.`);
    router.replace("/");
  }, [hydrated, urlHandle, records.length, selectedRecord, router]);

  async function handleUpload(file: File) {
    setIsUploading(true);
    setError(null);
    try {
      const { records: parsed, rawRows: rows } = await parseTranslationCSV(file);
      if (parsed.length === 0) {
        setError(
          "No records found. Please upload a Shopify Translate & Adapt export CSV " +
            "(Admin → Content → Translate & Adapt → Export)."
        );
        return;
      }
      // Shopify CSVs include a Locale column; if it is absent or empty (non-standard
      // exports), fall back to the current active locale so push targets the right language.
      const fallbackLocale = readActiveLocale();
      const records = parsed.map((r) => {
        if (r.locale) return r;
        const locale = fallbackLocale;
        return { ...r, locale, id: `${r.type}__${r.identification}__${locale}` };
      });
      setRecords(records);
      setRawRows(rows);
      setFilename(file.name);
      setSessionPushedIds(new Set());
      try {
        sessionStorage.removeItem(SESSION_TABLE_FILTERS_KEY);
      } catch {
        /* ignore */
      }
      setTableFilters({ ...DEFAULT_TABLE_FILTERS });
    } catch (e) {
      setError(`Failed to parse CSV: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setIsUploading(false);
    }
  }

  // Show a patience message after 15 s of active sync so users don't abandon.
  useEffect(() => {
    if (!isUploading) { setSyncSlowWarning(false); return; }
    const t = setTimeout(() => setSyncSlowWarning(true), 15_000);
    return () => clearTimeout(t);
  }, [isUploading]);

  const handleLoadFromShopifySync = useCallback(async (opts?: { force?: boolean; forceBackup?: boolean }) => {
    // First launch: hardcoded PRODUCT + COLLECTION, ignores checkbox state.
    // Subsequent syncs: use whatever types are checked (full sync always).
    const isFirstLaunch = readLastSyncAt() === null;
    const checkedTypes = readSyncTypesFromStorage();
    const syncTypeParam = isFirstLaunch ? "PRODUCT,COLLECTION" : checkedTypes.join(",");
    const force       = opts?.force       === true;
    const forceBackup = opts?.forceBackup === true;

    setIsUploading(true);
    setError(null);
    setSyncProgressPct(0);
    setSyncTypeProgress([]);
    // Use the ref so the snapshot is accurate at call-time without adding `records`
    // to the useCallback dep array (which would recreate it on every typeRows update).
    const prevSnapshot = recordsRef.current;
    try {
      const settings = requireShopifyDomainForApi();

      // Read the active locale from localStorage (set by SyncToolbar / Settings).
      // Pass it to both the API (so Shopify returns translations for the right locale)
      // and to the mapper (so record.locale is correct for push).
      const targetLocale = readActiveLocale(settings.shopifyDomain);

      const rows = await fetchShopifySyncProductRows(
        {
          shopifyDomain: settings.shopifyDomain,
          shopifyClientId: settings.shopifyClientId,
          shopifyClientSecret: settings.shopifyClientSecret,
        },
        (pct) => setSyncProgressPct(pct),
        {
          stream: true,
          type: syncTypeParam,
          targetLocale,
          ...(force       ? { force:       true } : {}),
          ...(forceBackup ? { forceBackup: true } : {}),
        },
        // Progressive update: render each type's rows the moment it finishes.
        // PRODUCT rows arrive at ~45 s — the table becomes visible immediately.
        // mergeShopifySyncWithPrevious preserves existing en_content for METAFIELD
        // records (Metafield resource translations aren't visible in the batch query).
        (resourceType, typeRows) => {
          const typeRecords = shopifySyncRowsToTranslationRecords(typeRows, targetLocale);
          setRecords((prev) => {
            const merged = mergeShopifySyncWithPrevious(typeRecords, prev);
            const mergedIds = new Set(merged.map((r) => r.id));
            return [...prev.filter((r) => !mergedIds.has(r.id)), ...merged];
          });
          setSyncTypeProgress((p) => [...p, { resourceType, count: typeRows.length }]);
        }
      );

      const parsed = shopifySyncRowsToTranslationRecords(rows, targetLocale);
      if (parsed.length === 0) {
        setError("No products returned from Shopify. Check store credentials and catalog.");
        return;
      }
      // Push badges are session-only; after a fresh pull, nothing is “pushed” until the user pushes again.
      setSessionPushedIds(() => new Set());
      setSelectionResetKey((k) => k + 1);
      setRecords(mergeShopifySyncWithPrevious(parsed, prevSnapshot));
      setRawRows([]);
      setFilename("Shopify API sync");
      const syncedAt = new Date().toISOString();
      const labelsUsed = syncTypeParam.split(",").map((t) => syncTypeLabel(t.trim()));
      writeLastSyncAt(syncedAt);
      writeLastSyncMeta({ timestamp: syncedAt, labels: labelsUsed });
      setLastSyncAt(syncedAt);
      setLastSyncLabels(labelsUsed);
      try {
        sessionStorage.removeItem(SESSION_TABLE_FILTERS_KEY);
      } catch {
        /* ignore */
      }
      setTableFilters({ ...DEFAULT_TABLE_FILTERS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load from Shopify";
      setError(msg);
      reportClientError("sync_error", msg, shopDomain ?? undefined);
    } finally {
      setIsUploading(false);
      setSyncProgressPct(null);
      setSyncTypeProgress([]);
    }
  }, [shopDomain]);

  // Auto-sync on startup: fires once when mobile/fresh WebView has no local state
  // but the shop domain is known from the Shopify-provided URL (?shop=…).
  useEffect(() => {
    if (!hydrated || !pendingAutoSync) return;
    setPendingAutoSync(false);
    void handleLoadFromShopifySync();
  }, [hydrated, pendingAutoSync, handleLoadFromShopifySync]);

  const handleTranslate = useCallback(
    async (
      id: string,
      skipExisting = true,
      options?: { suppressSkipFeedback?: boolean }
    ): Promise<TranslateRunResult> => {
      const record = records.find((r) => r.id === id);
      if (!record) return "not_found";

      const suppress = options?.suppressSkipFeedback === true;

      setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, isTranslating: true } : r)));
      if (!suppress) setError(null);

      const fieldsToTranslate: TranslateRequestField[] = record.fields
        .filter((f) => {
          if (f.field === "__display_title__") return false; // synthetic — never translate
          if (!f.ru_content.trim()) return false;
          if (skipExisting && !isEffectivelyEmpty(f.en_content) && f.status === "done") {
            // Force re-translation if an HTML field still has the broken bracket-tag structure
            // (e.g. <p>[short_description]</p>) from before the HTML fix was deployed.
            // Also fall back to key-name check for old records where fieldType may be undefined.
            const isHtmlField =
              f.fieldType === "html" ||
              f.field === "body_html" ||
              f.field === "description" ||
              f.field === "content";
            const hasBrokenBracketTag =
              isHtmlField &&
              /<p>\s*\[(\/?short_description|\/?product_description)\]/.test(f.en_content ?? "");
            if (!hasBrokenBracketTag) return false;
          }
          return true;
        })
        .map((f) => ({ key: f.field, text: f.ru_content, fieldType: f.fieldType }));

      if (fieldsToTranslate.length === 0) {
        setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, isTranslating: false } : r)));
        if (!suppress) {
          setError(`Nothing to translate — ${explainNoFieldsToTranslate(record, skipExisting)}`);
        }
        return "skipped";
      }

      setSessionPushedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });

      try {
        const settings = loadSettings();
        const results = await translateFields(fieldsToTranslate, {
          ...settings,
          targetLanguage: readActiveLocale(settings.shopifyDomain),
        });

        setRecords((prev) =>
          prev.map((r) => {
            if (r.id !== id) return r;
            const updatedFields = r.fields.map((f) => {
              const result = results.find((res) => res.key === f.field);
              if (!result) return f;
              if (result.error) {
                // Translation failed. If the existing en_content is also Cyrillic
                // (old bad data from a previous sync), clear it so the field shows
                // as needing translation rather than silently keeping Russian text.
                const enIsCyrillic = /[\u0400-\u04FF]/.test(f.en_content ?? "");
                if (enIsCyrillic) {
                  return { ...f, en_content: "", status: "missing" as const };
                }
                return f;
              }
              if (!result.translation) return f;
              return { ...f, en_content: result.translation, status: "done" as const };
            });
            const titleField = updatedFields.find((f) => f.field === "title");
            const titleTranslated = results.some((res) => res.key === "title" && res.translation && !res.error);
            let sourceTitleAtSync = r.sourceTitleAtSync;
            if (titleTranslated && titleField) {
              sourceTitleAtSync = titleField.ru_content;
            }
            return {
              ...r,
              fields: updatedFields,
              status: deriveRecordStatus(updatedFields),
              translation_status: deriveTranslationStatus(updatedFields),
              isTranslating: false,
              translatedAt: Date.now(),
              sourceTitleAtSync,
            };
          })
        );
        return "ok";
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Translation failed — please try again.";
        setError(msg);
        reportClientError("translate_error", msg, shopDomain ?? undefined);
        setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, isTranslating: false } : r)));
        return "error";
      }
    },
    [records, shopDomain]
  );

  const handleTranslateSelected = useCallback(
    async (ids: string[], forceRetranslate = false) => {
      if (!ids.length) return;
      setError(null);
      setIsTranslatingBulk(true);
      // When forceRetranslate=true (all selected are already translated), pass
      // skipExisting=false so handleTranslate includes already-done fields.
      const skipExisting = !forceRetranslate;
      let ok = 0;
      let skippedNoSource = 0;    // genuinely missing ru_content
      let skippedAlreadyDone = 0; // all fields already have a current translation
      let errored = false;

      // Track first 5 skipped records for diagnostics
      const skippedDiag: Array<{ id: string; fields: string }> = [];

      try {
        for (const id of ids) {
          const rec = records.find((r) => r.id === id);
          const result = await handleTranslate(id, skipExisting, { suppressSkipFeedback: true });
          if (result === "ok") {
            ok += 1;
          } else if (result === "skipped") {
            if (!rec) {
              skippedNoSource += 1;
            } else {
              // Classify: all fields already translated, or no source text?
              const allDone = rec.fields.every(
                (f) => f.ru_content.trim() && !forceRetranslate && !isEffectivelyEmpty(f.en_content) && f.status === "done"
              );
              if (allDone) {
                skippedAlreadyDone += 1;
              } else {
                skippedNoSource += 1;
                if (skippedDiag.length < 5) {
                  const fieldSummary = rec.fields
                    .map((f) => `${f.field}=ru:"${f.ru_content.slice(0, 20)}" en:"${f.en_content.slice(0, 20)}"`)
                    .join("; ");
                  skippedDiag.push({ id: rec.id, fields: fieldSummary });
                }
              }
            }
          } else if (result === "error") {
            errored = true;
          }
        }

        if (skippedDiag.length > 0) {
          console.warn(
            `[translate] ${skippedNoSource} item(s) skipped — no source content. First ${skippedDiag.length} affected:`,
            skippedDiag
          );
        }

        const totalSkipped = skippedNoSource + skippedAlreadyDone;
        if (!errored && totalSkipped > 0) {
          if (ok === 0 && skippedAlreadyDone === 0) {
            // Everything was skipped due to missing source — likely a sync issue
            const sample = ids
              .map((id) => records.find((r) => r.id === id))
              .find((r): r is TranslationRecord => r != null);
            const detail = sample ? explainNoFieldsToTranslate(sample, skipExisting) : "";
            setError(`Nothing to translate for ${skippedNoSource} selected item(s). ${detail}`);
          } else if (skippedAlreadyDone > 0 && skippedNoSource === 0) {
            // All skipped because already translated — not an error, just info
            setError(null);
          } else {
            // Mixed: some translated, some skipped
            const parts: string[] = [];
            if (ok > 0) parts.push(`Translated ${ok}`);
            if (skippedAlreadyDone > 0) parts.push(`${skippedAlreadyDone} already translated`);
            if (skippedNoSource > 0) parts.push(`${skippedNoSource} skipped — no source text (re-sync to repair)`);
            setError(parts.join(" · "));
          }
        } else {
          setError(null);
        }
      } finally {
        setIsTranslatingBulk(false);
      }
    },
    [handleTranslate, records]
  );

  const handlePushSelected = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      const eligibleIds = ids.filter((id) => {
        const r = records.find((x) => x.id === id);
        return r && canPushTranslationRecord(r);
      });
      if (eligibleIds.length === 0) {
        setError("Nothing to push — translate selected items first (fully untranslated rows cannot be pushed).");
        return;
      }
      setError(null);
      setIsPushingBulk(true);
      const failures: string[] = [];
      const pushedOkIds: string[] = [];
      try {
        for (const id of eligibleIds) {
          const record = records.find((r) => r.id === id);
          if (!record) continue;
          try {
            await pushRecordToShopify(record);
            pushedOkIds.push(id);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            failures.push(`“${record.handle}”: ${msg}`);
          }
        }
        if (pushedOkIds.length > 0) {
          setSessionPushedIds((prev) => {
            const next = new Set(prev);
            for (const pid of pushedOkIds) next.add(pid);
            return next;
          });
        }
        if (failures.length > 0) {
          setError(
            failures.length === eligibleIds.length
              ? failures.slice(0, 5).join("\n") + (failures.length > 5 ? `\n… and ${failures.length - 5} more` : "")
              : `Some pushes failed (${failures.length}):\n${failures.slice(0, 8).join("\n")}` +
                  (failures.length > 8 ? `\n… and ${failures.length - 8} more` : "")
          );
        }
      } finally {
        setIsPushingBulk(false);
        setSelectionResetKey((k) => k + 1);
      }
    },
    [records]
  );

  const handlePushRow = useCallback(
    async (id: string) => {
      const record = records.find((r) => r.id === id);
      if (!record || !canPushTranslationRecord(record)) return;
      setError(null);
      setPushingRowId(id);
      try {
        await pushRecordToShopify(record);
        setSessionPushedIds((prev) => new Set(prev).add(id));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Push failed";
        setError(msg);
        reportClientError("push_error", msg, shopDomain ?? undefined);
      } finally {
        setPushingRowId(null);
        setSelectionResetKey((k) => k + 1);
      }
    },
    [records, shopDomain]
  );

  function handleSave(updated: TranslationRecord) {
    setSessionPushedIds((prev) => {
      const next = new Set(prev);
      next.delete(updated.id);
      return next;
    });
    const titleField = updated.fields.find((f) => f.field === "title");
    const nextSourceTitle =
      titleField && titleField.status !== "outdated"
        ? titleField.ru_content
        : updated.sourceTitleAtSync;

    setRecords((prev) =>
      prev.map((r) =>
        r.id === updated.id
          ? {
              ...updated,
              status: deriveRecordStatus(updated.fields),
              translation_status: deriveTranslationStatus(updated.fields),
              translatedAt: Date.now(),
              sourceTitleAtSync: nextSourceTitle,
            }
          : r
      )
    );
  }

  const openEditor = useCallback(
    (id: string) => {
      const r = records.find((x) => x.id === id);
      if (!r) return;
      try {
        const el = document.getElementById("shopify-translator-list-scroll");
        if (el) sessionStorage.setItem(SESSION_LIST_SCROLL_KEY, String(el.scrollTop));
      } catch {
        /* quota / private mode */
      }
      router.push(`/p/${encodeURIComponent(r.handle)}`);
    },
    [records, router]
  );

  function mergeFieldsIntoRecord(base: TranslationRecord, fields: TranslationField[]): TranslationRecord {
    const titleField = fields.find((f) => f.field === "title" || f.field === "name");
    const nextSourceTitle =
      titleField && titleField.status !== "outdated"
        ? titleField.ru_content
        : base.sourceTitleAtSync;
    return {
      ...base,
      fields,
      status: deriveRecordStatus(fields),
      translation_status: deriveTranslationStatus(fields),
      translatedAt: Date.now(),
      sourceTitleAtSync: nextSourceTitle,
    };
  }

  const handleInlineFieldChange = useCallback(
    (recordId: string, fieldKey: string, value: string) => {
      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId) return r;
          const fields = r.fields.map((f) =>
            f.field === fieldKey
              ? {
                  ...f,
                  en_content: value,
                  status: isEffectivelyEmpty(value) ? ("missing" as const) : ("done" as const),
                }
              : f
          );
          return mergeFieldsIntoRecord(r, fields);
        })
      );
    },
    []
  );

  const handleInlineSaveRow = useCallback((recordId: string) => {
    setSessionPushedIds((prev) => {
      const next = new Set(prev);
      next.delete(recordId);
      return next;
    });
  }, []);

  const handleInlineTranslateRow = useCallback(
    (recordId: string) => {
      void handleTranslate(recordId, true);
    },
    [handleTranslate]
  );

  const handleMarkReviewedSelected = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setRecords((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, reviewed: true } : r)));
  }, []);

  const handleReplaceAll = useCallback((find: string, replace: string, targetIds?: string[]): number => {
    if (!find || find === replace) return 0;
    const replaceAllInsensitive = (text: string, needle: string, replacement: string): string => {
      if (!needle) return text;
      const hay = text.toLowerCase();
      const ndl = needle.toLowerCase();
      let out = "";
      let cursor = 0;
      while (true) {
        const hit = hay.indexOf(ndl, cursor);
        if (hit === -1) {
          out += text.slice(cursor);
          break;
        }
        out += text.slice(cursor, hit) + replacement;
        cursor = hit + needle.length;
      }
      return out;
    };
    let updatedItems = 0;
    // Compute next records synchronously so count is accurate before returning
    const targetSet = targetIds?.length ? new Set(targetIds) : null;
    const nextRecords = records.map((r) => {
      if (targetSet && !targetSet.has(r.id)) return r;
      const newFields = r.fields.map((f) => {
        const ru = f.ru_content ?? "";
        const en = f.en_content ?? "";
        const ruHit = ru.toLowerCase().includes(find.toLowerCase());
        const enHit = en.toLowerCase().includes(find.toLowerCase());
        if (!ruHit && !enHit) return f;
        return {
          ...f,
          ru_content: ruHit ? replaceAllInsensitive(ru, find, replace) : ru,
          en_content: enHit ? replaceAllInsensitive(en, find, replace) : en,
        };
      });
      const changed = newFields.some((nf, i) => nf !== r.fields[i]);
      // Mark changed records as recently modified so they sort to the top
      if (changed) updatedItems += 1;
      return changed ? { ...r, fields: newFields, translatedAt: Date.now() } : r;
    });
    setRecords(nextRecords);
    return updatedItems;
  }, [records]);

  const isTranslatingAny = records.some((r) => r.isTranslating);

  // METAFIELD records that belong to the currently open resource (PRODUCT or COLLECTION),
  // shown embedded inside the editor rather than as standalone list rows.
  // Handle format for metafields is "${parentHandle}/${namespaceKey}", so we use startsWith.
  const productMetafieldRecords = useMemo(() => {
    if (!selectedRecord) return [];
    const parentType = selectedRecord.type;
    if (parentType !== "PRODUCT" && parentType !== "COLLECTION") return [];
    const prefix = selectedRecord.handle + "/";
    return records.filter(
      (r) =>
        r.type === "METAFIELD" &&
        r.fields.find((f) => f.parentType)?.parentType === parentType &&
        (r.handle === selectedRecord.handle || r.handle.startsWith(prefix))
    );
  }, [selectedRecord, records]);

  // METAOBJECT records (e.g. FAQ entries) referenced by the current resource via
  // list.metaobject_reference / metaobject_reference metafields — shown inline in the editor.
  const productFaqRecords = useMemo(() => {
    if (!selectedRecord) return [];
    if (selectedRecord.type !== "PRODUCT" && selectedRecord.type !== "COLLECTION") return [];
    const refs = selectedRecord.metaobjectRefs;
    if (!refs?.length) return [];
    const refSet = new Set(refs);
    return records.filter((r) => r.type === "METAOBJECT" && refSet.has(r.identification));
  }, [selectedRecord, records]);

  function handleNavigate(direction: "prev" | "next") {
    if (selectedIndex === -1) return;
    const next = direction === "prev" ? selectedIndex - 1 : selectedIndex + 1;
    if (next >= 0 && next < records.length) {
      const r = records[next];
      router.replace(`/p/${encodeURIComponent(r.handle)}`);
    }
  }

  if (!hydrated) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        {/* Skeleton header — matches real header height to avoid layout shift */}
        <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-20 shrink-0">
          <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-y-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 leading-none">LocaleFlow</p>
              <p className="hidden min-[360px]:block text-sm text-gray-400 mt-0.5 leading-snug">Manage and translate your Shopify content</p>
            </div>
          </div>
        </header>
        {/* Subtle centered spinner — avoids a jarring blank screen on mobile */}
        <main className="flex-1 flex items-center justify-center">
          <svg className="w-6 h-6 text-gray-300 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </main>
      </div>
    );
  }

  const params = new URLSearchParams(window.location.search);
  const forceEmpty = params.get("empty") === "true";
  const forceEmptyList = forceEmpty;
  /** Home list only: `?empty=true` forces empty UI when records exist; `/p/...` still shows editors. */
  const showMainView = (!forceEmptyList || urlHandle) && records.length > 0;

  const sharedHeader = (
    <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-20 shrink-0">
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-y-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 leading-none">LocaleFlow</p>
            <p className="hidden min-[360px]:block text-sm text-gray-400 mt-0.5 leading-snug">Manage and translate your Shopify content</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filename && filename !== "Shopify API sync" && showMainView && (
              <div className="flex items-center gap-2 text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 min-w-0 max-w-full overflow-hidden">
                <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="font-medium text-gray-700 truncate">{filename}</span>
                <span className="text-gray-400">· {records.length.toLocaleString()} records</span>
              </div>
            )}
            <Link
              href="/settings"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800 hover:bg-gray-100 border border-gray-200 rounded-lg transition-all"
              title="Translation Settings"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
          </div>
        </div>
      </header>
  );

  const errorBanner = error ? (
    <div className="mb-6 flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 break-words">
      <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div className="flex-1">
        <p className="font-semibold">Error</p>
        <p className="mt-0.5">{error}</p>
      </div>
      <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  ) : null;

  if (!showMainView) {
    // "First launch" only when there's no Shopify session context AND no prior
    // lastSyncAt — i.e. the user opened the URL directly for the very first time.
    // When shopDomain is provided, auto-sync will fire so this screen is transient.
    const isFirstLaunch = !shopDomain && readLastSyncAt() === null;
    const primaryLabel =
      isUploading && syncProgressPct !== null
        ? "Syncing…"
        : isUploading
          ? "Loading…"
          : "Sync";

    return (
      <div className="min-h-screen bg-slate-50 flex flex-col overflow-x-hidden">
        {sharedHeader}
        <main className="flex-1 w-full flex flex-col items-center px-4 sm:px-6 py-12">
          {errorBanner}
          <div className="w-full max-w-[520px] mx-auto flex flex-col items-center text-center gap-6">
            <div className="flex flex-col gap-3 w-full">
              <h2 className="text-2xl font-semibold text-gray-900 tracking-tight">
                Translate your store content
              </h2>
              {isFirstLaunch ? (
                <p className="text-gray-500 text-[14px] leading-[18px]">
                  Syncs active products and collections to get started
                </p>
              ) : (
                <p className="text-gray-500 text-[14px] leading-[18px]">
                  Sync your store content to continue
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => void handleLoadFromShopifySync()}
              disabled={isUploading}
              className="w-full max-w-sm px-5 py-4 bg-[#008060] text-white text-base font-semibold rounded-xl hover:bg-[#006e52] shadow-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {primaryLabel}
            </button>

            {isFirstLaunch && !isUploading && (
              <div className="text-sm text-gray-500 space-y-2 w-full max-w-sm text-left">
                <p>✔ Active products + Collections</p>
                <p>✔ No changes will be made yet</p>
                <p>✔ Takes ~10–30 seconds</p>
              </div>
            )}

            {syncProgressPct !== null && isUploading && (
              <div className="w-full max-w-sm space-y-2">
                <div className="flex justify-between text-xs text-gray-600 mb-1.5">
                  <span>Syncing from Shopify</span>
                  <span className="tabular-nums font-medium">{syncProgressPct}%</span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#008060] rounded-full transition-[width] duration-300 ease-out"
                    style={{ width: `${syncProgressPct}%` }}
                  />
                </div>
                {syncSlowWarning && (
                  <p className="text-xs text-gray-500 text-center pt-1">
                    Sync in progress — this may take a few minutes for large stores
                  </p>
                )}
                {syncTypeProgress.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {syncTypeProgress.map(({ resourceType, count }) => (
                      <span
                        key={resourceType}
                        className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded-full px-2.5 py-0.5"
                      >
                        {syncTypeLabel(resourceType)}: {count.toLocaleString()} ✓
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="w-full pt-8 mt-2 border-t border-gray-200 flex flex-col items-center gap-4">
              <p className="text-sm text-gray-500">Or import from CSV</p>
              <input
                ref={csvEmptyStateInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                aria-hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    if (!file.name.toLowerCase().endsWith(".csv")) {
                      setError("Please choose a .csv file.");
                    } else {
                      handleUpload(file);
                    }
                  }
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => csvEmptyStateInputRef.current?.click()}
                disabled={isUploading}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
              >
                Upload CSV
              </button>
              <p className="w-full text-xs text-gray-400 text-center leading-snug">
                Export from Shopify (Settings → Languages → Export)
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const tableSection = (
    <div className="max-w-screen-xl mx-auto w-full px-4 lg:px-6 py-6">
      {isUploading && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">
          <svg className="w-4 h-4 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span className="font-medium">Syncing from Shopify…</span>
          {syncTypeProgress.map(({ resourceType, count }) => (
            <span
              key={resourceType}
              className="inline-flex items-center gap-1 bg-white border border-blue-200 rounded-full px-2.5 py-0.5 text-xs text-blue-700"
            >
              {syncTypeLabel(resourceType)}: {count.toLocaleString()} ✓
            </span>
          ))}
        </div>
      )}
      {errorBanner}
      <ProductTable
        records={records}
        onOpenEditor={openEditor}
        onTranslate={handleTranslate}
        onTranslateSelected={handleTranslateSelected}
        onPushSelected={handlePushSelected}
        onInlineFieldChange={handleInlineFieldChange}
        onInlineSaveRow={handleInlineSaveRow}
        onInlineTranslateRow={handleInlineTranslateRow}
        onPushRow={handlePushRow}
        pushingRowId={pushingRowId}
        isTranslatingAny={isTranslatingAny}
        isPushingBulk={isPushingBulk}
        selectionResetKey={selectionResetKey}
        sessionPushedIds={sessionPushedIds}
        filterState={tableFilters}
        onFilterChange={persistTableFilters}
        activeRowId={null}
        onSyncFromShopify={handleLoadFromShopifySync}
        isUploading={isUploading}
        isShopifySyncing={isUploading && syncProgressPct !== null}
        syncProgressPct={syncProgressPct}
        lastSyncAt={lastSyncAt}
        lastSyncLabels={lastSyncLabels}
        onReplaceAll={handleReplaceAll}
        isTranslatingBulk={isTranslatingBulk}
      />
    </div>
  );

  /** Full-page editor on `/p/[handle]` — list lives only on `/`. */
  if (urlHandle && selectedRecord) {
    const pushedHandler = (rid: string) => {
      setSessionPushedIds((prev) => new Set(prev).add(rid));
    };

    if (selectedRecord.type === "MENU") {
      const menuLinkRecords = records.filter(
        (r) => r.type === "LINK" && r.parentMenuId === selectedRecord.identification,
      );
      return (
        <MenuEditor
          key={selectedRecord.id}
          record={selectedRecord}
          linkRecords={menuLinkRecords}
          onSave={handleSave}
          onBack={() => router.push("/")}
          onPushedToShopify={pushedHandler}
        />
      );
    }

    if (selectedRecord.type === "ONLINE_STORE_THEME") {
      return (
        <ThemeEditor
          key={selectedRecord.id}
          layout="page"
          record={selectedRecord}
          recordIndex={selectedIndex}
          totalRecords={records.length}
          onSave={handleSave}
          onTranslate={handleTranslate}
          onPushedToShopify={pushedHandler}
          onBack={() => router.push("/")}
          onNavigate={handleNavigate}
        />
      );
    }

    return (
      <ProductEditor
        key={selectedRecord.id}
        layout="page"
        record={selectedRecord}
        recordIndex={selectedIndex}
        totalRecords={records.length}
        onSave={handleSave}
        onTranslate={handleTranslate}
        onPushedToShopify={pushedHandler}
        onBack={() => router.push("/")}
        onNavigate={handleNavigate}
        metafieldRecords={productMetafieldRecords}
        onSaveMetafield={handleSave}
        faqRecords={productFaqRecords}
        onSaveFaq={handleSave}
      />
    );
  }

  if (urlHandle && !selectedRecord) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        {sharedHeader}
        <div className="flex flex-1 flex-col items-center justify-center p-8">
          <p className="text-sm text-gray-500">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-slate-50">
      {sharedHeader}
      <div
        id="shopify-translator-list-scroll"
        className="min-h-0 flex-1 overflow-y-auto scroll-smooth"
      >
        {tableSection}
      </div>
    </div>
  );
}
