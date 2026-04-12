"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ShopifySyncResourceType } from "@/types";
import { formatLastSyncedRelative } from "@/utils/lastSyncAt";
import { useDetectedSyncTypes } from "@/hooks/useDetectedSyncTypes";
import { loadSettings } from "@/lib/settingsStorage";
import { LOCALE_STORAGE_KEY_PREFIX } from "@/lib/activeLocaleStorage";
import { normalizeNestedProductSyncTypes } from "@/lib/nestedProductSyncTypes";

export const SYNC_TYPES_STORAGE_KEY = "localeflow_sync_types_v2";
export { LOCALE_STORAGE_KEY_PREFIX } from "@/lib/activeLocaleStorage";

interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}
const CONTENT_TYPES = [
  "PRODUCT",
  "COLLECTION",
  "PAGE",      // canonical 2025-07 (was ONLINE_STORE_PAGE)
  "ARTICLE",   // canonical 2025-07 (was ONLINE_STORE_ARTICLE)
  "BLOG",      // canonical 2025-07 (was ONLINE_STORE_BLOG)
  "ONLINE_STORE_THEME",
] as const;
const STORE_TYPES = [
  "MENU",
  "SHOP",
  "SELLING_PLAN",
  "SELLING_PLAN_GROUP",
] as const;
/** Policies are displayed as a sub-item under PAGE but synced independently. */
const NESTED_PAGE_TYPES = ["SHOP_POLICY"] as const;
const ADVANCED_TYPES = [
  "DELIVERY_METHOD_DEFINITION",
  "EMAIL_TEMPLATE",
  // SMS_TEMPLATE / SHOP_SMS_TEMPLATE confirmed invalid on 2025-07 — removed
  "PAYMENT_GATEWAY",
  "PACKING_SLIP_TEMPLATE",
  "FILTER",
] as const;
const METADATA_TYPES = ["METAFIELD", "METAOBJECT"] as const;
/** Option types that can be synced independently — no longer require PRODUCT. */
const NESTED_PRODUCT_OPTION_TYPES = ["PRODUCT_OPTION", "PRODUCT_OPTION_VALUE"] as const;
/** Image alt sub-item for PRODUCT — synced via the MEDIA_IMAGE resource type. */
const NESTED_MEDIA_IMAGE_TYPES = ["MEDIA_IMAGE"] as const;
const SUPPORTED_SYNC_TYPES = [
  ...CONTENT_TYPES, ...STORE_TYPES, ...ADVANCED_TYPES, ...METADATA_TYPES,
  ...NESTED_PRODUCT_OPTION_TYPES, ...NESTED_PAGE_TYPES, ...NESTED_MEDIA_IMAGE_TYPES,
] as const;
export const DEFAULT_SYNC_TYPES: ShopifySyncResourceType[] = ["PRODUCT", "COLLECTION"];

// ── Canonical label map (Shopify type → display name) ─────────────────────────
export const SYNC_TYPE_LABELS: Record<string, string> = {
  PRODUCT:                    "Products",
  COLLECTION:                 "Collections",
  // Canonical 2025-07 names
  PAGE:                       "Pages",
  ARTICLE:                    "Articles",
  BLOG:                       "Blogs",
  // Legacy aliases (kept so stored values still display correctly)
  ONLINE_STORE_PAGE:          "Pages",
  ONLINE_STORE_ARTICLE:       "Articles",
  ONLINE_STORE_BLOG:          "Blogs",
  ONLINE_STORE_THEME:         "Themes",
  MENU:                       "Menus",
  LINK:                       "Menu items",      // individual navigation links (auto-synced with Menus)
  ONLINE_STORE_MENU:          "Menus",           // legacy alias
  SHOP:                       "Shop",
  SHOP_POLICY:                "Shop policies",
  DELIVERY_METHOD_DEFINITION: "Delivery methods",
  EMAIL_TEMPLATE:             "Email templates",
  PAYMENT_GATEWAY:            "Payment gateways",
  PACKING_SLIP_TEMPLATE:      "Packing slip",
  SELLING_PLAN:               "Selling plans",
  SELLING_PLAN_GROUP:         "Selling plan groups",
  FILTER:                     "Filters",
  METAFIELD:                  "Metafields",
  METAOBJECT:                 "Metaobjects",
  PRODUCT_VARIANT:            "Product variants",
  PRODUCT_OPTION:             "Product options",
  PRODUCT_OPTION_VALUE:       "Product option values",
  MEDIA_IMAGE:                "Product image alts",
};

export function syncTypeLabel(type: string): string {
  return SYNC_TYPE_LABELS[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Group definitions ─────────────────────────────────────────────────────────
interface SyncGroup {
  label: string;
  note?: string;
  collapsible?: boolean;
  types: string[];
}

const SYNC_GROUPS: SyncGroup[] = [
  {
    label: "CONTENT",
    types: [...CONTENT_TYPES],
  },
  {
    label: "STORE",
    types: [...STORE_TYPES],
  },
  {
    label: "METADATA",
    note: "slower",
    types: [...METADATA_TYPES],
  },
  {
    label: "ADVANCED",
    note: "rarely needed",
    collapsible: true,
    types: [...ADVANCED_TYPES],
  },
];

/** ALL_SYNC_OPTIONS — flat ordered list used by TranslatorApp empty state. */
export const ALL_SYNC_OPTIONS: { id: ShopifySyncResourceType; label: string; note?: string }[] =
  SYNC_GROUPS.flatMap((g) =>
    g.types
      .map((t) => ({
        id: t as ShopifySyncResourceType,
        label: syncTypeLabel(t),
        note: g.note,
      }))
  );

export function sanitizeSyncTypes(types: ShopifySyncResourceType[]): ShopifySyncResourceType[] {
  const allowed = new Set<string>(SUPPORTED_SYNC_TYPES);
  const seen = new Set<string>();
  const filtered: ShopifySyncResourceType[] = [];
  for (const t of types) {
    if (!allowed.has(t) || seen.has(t)) continue;
    seen.add(t);
    filtered.push(t);
  }
  return filtered.length ? filtered : DEFAULT_SYNC_TYPES;
}

export function readSyncTypesFromStorage(): ShopifySyncResourceType[] {
  try {
    const s = localStorage.getItem(SYNC_TYPES_STORAGE_KEY);
    if (s) {
      return normalizeNestedProductSyncTypes(
        sanitizeSyncTypes(JSON.parse(s) as ShopifySyncResourceType[]),
      );
    }
  } catch { /* ignore */ }
  try {
    localStorage.setItem(SYNC_TYPES_STORAGE_KEY, JSON.stringify(DEFAULT_SYNC_TYPES));
  } catch { /* ignore */ }
  return DEFAULT_SYNC_TYPES;
}

export function writeSyncTypesToStorage(types: ShopifySyncResourceType[]): void {
  try {
    const normalized = normalizeNestedProductSyncTypes(sanitizeSyncTypes(types));
    localStorage.setItem(SYNC_TYPES_STORAGE_KEY, JSON.stringify(normalized));
  } catch { /* ignore */ }
}

interface SyncToolbarProps {
  onSync: (opts?: { force?: boolean; forceBackup?: boolean }) => void;
  disabled?: boolean;
  isSyncing?: boolean;
  syncProgressPct?: number | null;
  lastSyncAt: string | null;
  lastSyncLabels?: string[] | null;
  compact?: boolean;
  /** When false, hides the inline "Last synced" text (caller renders it elsewhere). */
  showLastSynced?: boolean;
}

export default function SyncToolbar({
  onSync,
  disabled,
  isSyncing,
  syncProgressPct,
  lastSyncAt,
  lastSyncLabels,
  compact,
  showLastSynced = true,
}: SyncToolbarProps) {
  const [tick, setTick] = useState(0);
  const [showTypes, setShowTypes] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [forceResync,  setForceResync]  = useState(false);
  const [forceBackup,  setForceBackup]  = useState(false);
  const [showMarketsInfo, setShowMarketsInfo] = useState(false);
  const [syncTypes, setSyncTypes] = useState<ShopifySyncResourceType[]>(DEFAULT_SYNC_TYPES);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Tooltips for nested sub-item ⓘ icons — panel-relative absolute positioning so they
  // can overflow the scroll container and even the dropdown panel boundary freely.
  const optionsIconRef = useRef<HTMLSpanElement>(null);
  const [optionsTip, setOptionsTip] = useState<{ top: number; left: number } | null>(null);
  const policyIconRef = useRef<HTMLSpanElement>(null);
  const [policyTip, setPolicyTip] = useState<{ top: number; left: number } | null>(null);
  const mediaImagesIconRef = useRef<HTMLSpanElement>(null);
  const [mediaImagesTip, setMediaImagesTip] = useState<{ top: number; left: number } | null>(null);

  // Read the connected shop domain so we can run type detection and locale fetch.
  const [shopDomain, setShopDomain] = useState<string | null>(null);
  useEffect(() => {
    const settings = loadSettings();
    setShopDomain(settings.shopifyDomain?.trim() || null);
  }, []);

  // ── Locale state ────────────────────────────────────────────────────────────
  const [shopLocales, setShopLocales] = useState<ShopLocale[]>([]);
  const [activeLocale, setActiveLocale] = useState<string>("");

  useEffect(() => {
    if (!shopDomain) return;

    // Restore saved locale (shared key with Settings page).
    const saved = (() => {
      try { return localStorage.getItem(`${LOCALE_STORAGE_KEY_PREFIX}${shopDomain}`); }
      catch { return null; }
    })();
    if (saved) setActiveLocale(saved);

    // Fetch non-primary locales.
    fetch(`/api/shopify/locales?shop=${encodeURIComponent(shopDomain)}`)
      .then((r) => r.json())
      .then((data: { locales?: ShopLocale[] }) => {
        const nonPrimary = (data.locales ?? []).filter((l) => !l.primary);
        setShopLocales(nonPrimary);
        // If saved locale is no longer in the list, fall back to first.
        if (nonPrimary.length > 0 && !nonPrimary.some((l) => l.locale === saved)) {
          const first = nonPrimary[0].locale;
          setActiveLocale(first);
          try { localStorage.setItem(`${LOCALE_STORAGE_KEY_PREFIX}${shopDomain}`, first); }
          catch { /* ignore */ }
        }
      })
      .catch(() => { /* silently ignore — locale picker is optional enhancement */ });
  }, [shopDomain]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLocaleChange(locale: string) {
    setActiveLocale(locale);
    if (shopDomain) {
      try { localStorage.setItem(`${LOCALE_STORAGE_KEY_PREFIX}${shopDomain}`, locale); }
      catch { /* ignore */ }
    }
  }

  // Load persisted types on mount (client-side only).
  useEffect(() => { setSyncTypes(readSyncTypesFromStorage()); }, []);

  // Auto-detect which content types the store has.
  const { detectedTypes } = useDetectedSyncTypes(
    showTypes ? shopDomain : null // lazy — only probe when dropdown is opened
  );

  // Always show all groups. Detection only tells us which types exist in the store
  // so we can dim the ones with no records — but never hide options entirely.
  const detectedSet = useMemo(
    () => (detectedTypes ? new Set<string>(detectedTypes) : null),
    [detectedTypes]
  );

  // Keep TranslatorApp in sync — it reads the same key before calling the API.
  function toggleType(id: ShopifySyncResourceType, checked: boolean) {
    let next: ShopifySyncResourceType[];
    if (checked) {
      next = sanitizeSyncTypes([...syncTypes, id]);
    } else {
      next = syncTypes.filter((t) => t !== id);
      // PRODUCT_OPTION/VALUE are now independent — unchecking PRODUCT no longer forces them off
    }
    setSyncTypes(next);
    writeSyncTypesToStorage(next);
  }

  function toggleProductOptions(checked: boolean) {
    // Options can be toggled independently — no PRODUCT dependency
    let next: ShopifySyncResourceType[];
    if (checked) {
      const s = new Set(syncTypes);
      for (const t of NESTED_PRODUCT_OPTION_TYPES) s.add(t);
      next = sanitizeSyncTypes([...s]);
    } else {
      next = syncTypes.filter((t) => t !== "PRODUCT_OPTION" && t !== "PRODUCT_OPTION_VALUE");
    }
    setSyncTypes(next);
    writeSyncTypesToStorage(next);
  }

  function toggleMediaImages(checked: boolean) {
    const next = checked
      ? sanitizeSyncTypes([...syncTypes, "MEDIA_IMAGE"])
      : syncTypes.filter((t) => t !== "MEDIA_IMAGE");
    setSyncTypes(next);
    writeSyncTypesToStorage(next);
  }

  // Close dropdown on outside click.
  useEffect(() => {
    if (!showTypes) return;
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowTypes(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTypes]);

  useEffect(() => {
    if (!lastSyncAt) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [lastSyncAt]);

  const relative = useMemo(
    () => (lastSyncAt != null ? formatLastSyncedRelative(lastSyncAt) : null),
    [lastSyncAt, tick]
  );

  const pad = compact ? "px-3 py-2" : "px-4 py-2.5 md:py-2";
  const syncing = Boolean(isSyncing);
  const pct =
    syncing && syncProgressPct != null && syncProgressPct >= 0
      ? Math.min(100, Math.round(syncProgressPct))
      : null;

  return (
    <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-nowrap">
      {/* ── Sync split button + dropdown in a tight positioning context ── */}
      <div className="relative flex items-stretch shrink-0" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => onSync(
            (forceResync || forceBackup)
              ? { ...(forceResync ? { force: true } : {}), ...(forceBackup ? { forceBackup: true } : {}) }
              : undefined
          )}
          disabled={disabled || syncing}
          className={`${pad} rounded-l-lg text-sm font-medium transition-all border border-r-0
            ${syncing || disabled
              ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
              : forceResync
                ? "bg-orange-50 text-orange-700 border-orange-300 hover:bg-orange-100 hover:border-orange-400"
                : forceBackup
                  ? "bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100 hover:border-amber-400"
                  : "bg-white text-[#006e52] border-gray-300 hover:border-[#008060]/50 hover:bg-[#008060]/5"
            }`}
          title={
            forceResync && forceBackup ? "Force re-fetch from Shopify and overwrite backup snapshot"
              : forceResync ? "Force re-fetch from Shopify, bypassing local cache"
              : forceBackup ? "Re-capture backup — overwrite stored snapshot with this sync's data"
              : "Run sync now using saved selection"
          }
        >
          {syncing
            ? (pct != null ? `Syncing… ${pct}%` : "Syncing…")
            : forceResync && forceBackup ? "⟳ Force sync + backup"
            : forceResync ? "⟳ Force sync"
            : forceBackup ? "⟳ Sync + overwrite backup"
            : "Sync"}
        </button>
        <button
          type="button"
          onClick={() => setShowTypes((s) => !s)}
          disabled={disabled || syncing}
          className={`px-2.5 rounded-r-lg text-sm font-medium transition-all border
            ${syncing || disabled
              ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
              : "bg-white text-[#006e52] border-gray-300 hover:border-[#008060]/50 hover:bg-[#008060]/5"
            }`}
          title="Sync options"
          aria-label="Sync options"
        >
          ▼
        </button>

        {/* Dropdown — anchored directly to the split button, not the whole toolbar row */}
        {showTypes && (
          <div className="sync-dropdown absolute left-0 top-full mt-1.5 z-[1000] bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-64 max-w-[calc(100vw-1rem)] flex flex-col max-h-[80vh]">

            {/* Header row — always visible, not scrolled */}
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-semibold text-gray-500 tracking-wide uppercase leading-none">Sync content</p>
                <div className="relative group/tip flex items-center">
                  {/* Info icon — matches heading gray, same visual weight */}
                  <svg
                    className="w-3 h-3 text-gray-500 hover:text-gray-700 cursor-default transition-colors shrink-0"
                    viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="1.5"
                  >
                    <circle cx="8" cy="8" r="6.75" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7.5v3.5" />
                    <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
                  </svg>
                  {/* Tooltip — escapes the scroll container via overflow-visible on outer panel */}
                  <div className="pointer-events-none absolute left-0 top-full mt-2 w-52 bg-gray-900 text-white text-[11px] leading-relaxed rounded-lg px-3 py-2 shadow-xl opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150 z-[1100]">
                    Select content types to include in the next sync. Products and Collections are synced by default.
                    <span className="absolute left-2 bottom-full w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-gray-900" />
                  </div>
                </div>
              </div>
            </div>

            {/* Grouped checkboxes — scrollable. No overflow-x needed: the one tooltip that
                previously escaped this container now uses position:fixed (see optionsTip state). */}
            <div className="flex flex-col gap-3 overflow-y-auto min-h-0">
              {SYNC_GROUPS.map((group, idx) => {
                const isCollapsible = group.collapsible === true;
                const isExpanded = !isCollapsible || advancedExpanded;
                return (
                  <div key={group.label}>
                    {isCollapsible ? (
                      <button
                        type="button"
                        onClick={() => setAdvancedExpanded((v) => !v)}
                        className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600 transition-colors mb-1.5 w-full text-left"
                      >
                        <svg
                          className={`w-2.5 h-2.5 shrink-0 transition-transform ${advancedExpanded ? "rotate-90" : ""}`}
                          fill="currentColor" viewBox="0 0 24 24"
                        >
                          <path d="M8 5l8 7-8 7V5z" />
                        </svg>
                        {group.label}
                        {group.note && (
                          <span className="ml-1 font-normal normal-case text-gray-300">({group.note})</span>
                        )}
                      </button>
                    ) : (
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
                        {group.label}
                        {group.note && (
                          <span className="ml-1 font-normal normal-case text-gray-300">({group.note})</span>
                        )}
                      </p>
                    )}
                    {isExpanded && (
                      <div className="flex flex-col gap-1">
                        {group.collapsible && (
                          <label
                            className="flex items-center gap-2 select-none text-sm text-gray-400 cursor-not-allowed"
                            title="SMS template translation is not supported on the current Shopify API version."
                          >
                            <input
                              type="checkbox"
                              className="w-3.5 h-3.5 shrink-0 cursor-not-allowed"
                              disabled
                              checked={false}
                              readOnly
                            />
                            <span className="truncate line-through">SMS templates</span>
                            <span className="ml-auto text-[10px] text-gray-300 shrink-0">unsupported</span>
                          </label>
                        )}
                        {group.types.map((type) => {
                          const notInStore = detectedSet !== null && !detectedSet.has(type);

                          if (type === "PAGE") {
                            return (
                              <div key={type} className="flex flex-col gap-1">
                                <label
                                  className={`flex items-center gap-2 cursor-pointer select-none text-sm
                                    ${notInStore ? "text-gray-400" : "text-gray-700 hover:text-gray-900"}`}
                                  title={notInStore ? "Not found in this store" : undefined}
                                >
                                  <input
                                    type="checkbox"
                                    className="w-3.5 h-3.5 accent-[#008060] shrink-0"
                                    checked={syncTypes.includes("PAGE")}
                                    onChange={(e) => toggleType("PAGE", e.target.checked)}
                                  />
                                  <span className="truncate">{syncTypeLabel(type)}</span>
                                  {notInStore && (
                                    <span className="ml-auto text-[10px] text-gray-300 shrink-0">none</span>
                                  )}
                                </label>
                                {/* Nested: Shop policies — syncs independently of Pages */}
                                <div className="ml-5 pl-1 border-l border-gray-100">
                                  <div className="flex items-center gap-2 text-sm select-none text-gray-700">
                                    <input
                                      type="checkbox"
                                      className="w-3.5 h-3.5 accent-[#008060] shrink-0 cursor-pointer"
                                      checked={syncTypes.includes("SHOP_POLICY")}
                                      onChange={(e) => toggleType("SHOP_POLICY", e.target.checked)}
                                    />
                                    <span className="truncate">Shop policies</span>
                                    <span
                                      ref={policyIconRef}
                                      className="flex items-center shrink-0 cursor-default"
                                      onMouseEnter={() => {
                                        const r = policyIconRef.current?.getBoundingClientRect();
                                        const p = dropdownRef.current?.getBoundingClientRect();
                                        if (r && p) setPolicyTip({
                                          top: r.bottom - p.top + 6,
                                          left: r.left - p.left + r.width / 2,
                                        });
                                      }}
                                      onMouseLeave={() => setPolicyTip(null)}
                                    >
                                      <svg
                                        className="w-3 h-3 text-gray-400 hover:text-gray-600"
                                        viewBox="0 0 16 16" fill="none"
                                        stroke="currentColor" strokeWidth="1.5" aria-hidden
                                      >
                                        <circle cx="8" cy="8" r="6.75" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7.5v3.5" />
                                        <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
                                      </svg>
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          if (type === "PRODUCT") {
                            return (
                              <div key={type} className="flex flex-col gap-1">
                                <label
                                  className={`flex items-center gap-2 cursor-pointer select-none text-sm
                                    ${notInStore ? "text-gray-400" : "text-gray-700 hover:text-gray-900"}`}
                                  title={notInStore ? "Not found in this store" : undefined}
                                >
                                  <input
                                    type="checkbox"
                                    className="w-3.5 h-3.5 accent-[#008060] shrink-0"
                                    checked={syncTypes.includes("PRODUCT")}
                                    onChange={(e) => toggleType("PRODUCT", e.target.checked)}
                                  />
                                  <span className="truncate">{syncTypeLabel(type)}</span>
                                  {notInStore && (
                                    <span className="ml-auto text-[10px] text-gray-300 shrink-0">none</span>
                                  )}
                                </label>
                                <div className="ml-5 pl-1 border-l border-gray-100 flex flex-col gap-0.5">
                                  <div className="flex items-start gap-2 text-sm select-none text-gray-700">
                                    <input
                                      type="checkbox"
                                      className="w-3.5 h-3.5 accent-[#008060] shrink-0 mt-0.5 cursor-pointer"
                                      checked={syncTypes.includes("PRODUCT_OPTION")}
                                      onChange={(e) => toggleProductOptions(e.target.checked)}
                                      title="Sync product options and their values (e.g. Size, Color). Can run independently without syncing Products."
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span>Options & values</span>
                                        <span
                                          ref={optionsIconRef}
                                          className="flex items-center shrink-0 cursor-default"
                                          onMouseEnter={() => {
                                            const r = optionsIconRef.current?.getBoundingClientRect();
                                            const p = dropdownRef.current?.getBoundingClientRect();
                                            if (r && p) setOptionsTip({
                                              top: r.bottom - p.top + 6,
                                              left: r.left - p.left + r.width / 2,
                                            });
                                          }}
                                          onMouseLeave={() => setOptionsTip(null)}
                                        >
                                          <svg
                                            className="w-3 h-3 text-gray-400 hover:text-gray-600"
                                            viewBox="0 0 16 16"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            aria-hidden
                                          >
                                            <circle cx="8" cy="8" r="6.75" />
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7.5v3.5" />
                                            <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
                                          </svg>
                                        </span>
                                      </div>
                                      <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">
                                        (size, color, etc.)
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-start gap-2 text-sm select-none text-gray-700">
                                    <input
                                      type="checkbox"
                                      className="w-3.5 h-3.5 accent-[#008060] shrink-0 mt-0.5 cursor-pointer"
                                      checked={syncTypes.includes("MEDIA_IMAGE")}
                                      onChange={(e) => toggleMediaImages(e.target.checked)}
                                      title="Sync alt text for product images."
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span>Product image alts</span>
                                        <span
                                          ref={mediaImagesIconRef}
                                          className="flex items-center shrink-0 cursor-default"
                                          onMouseEnter={() => {
                                            const r = mediaImagesIconRef.current?.getBoundingClientRect();
                                            const p = dropdownRef.current?.getBoundingClientRect();
                                            if (r && p) setMediaImagesTip({
                                              top: r.bottom - p.top + 6,
                                              left: r.left - p.left + r.width / 2,
                                            });
                                          }}
                                          onMouseLeave={() => setMediaImagesTip(null)}
                                        >
                                          <svg
                                            className="w-3 h-3 text-gray-400 hover:text-gray-600"
                                            viewBox="0 0 16 16"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            aria-hidden
                                          >
                                            <circle cx="8" cy="8" r="6.75" />
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7.5v3.5" />
                                            <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
                                          </svg>
                                        </span>
                                      </div>
                                      <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">
                                        alt text for product images
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <label
                              key={type}
                              className={`flex items-center gap-2 cursor-pointer select-none text-sm
                                ${notInStore ? "text-gray-400" : "text-gray-700 hover:text-gray-900"}`}
                              title={notInStore ? "Not found in this store" : undefined}
                            >
                              <input
                                type="checkbox"
                                className="w-3.5 h-3.5 accent-[#008060] shrink-0"
                                checked={syncTypes.includes(type as ShopifySyncResourceType)}
                                onChange={(e) => toggleType(type as ShopifySyncResourceType, e.target.checked)}
                              />
                              <span className="truncate">{syncTypeLabel(type)}</span>
                              {notInStore && (
                                <span className="ml-auto text-[10px] text-gray-300 shrink-0">none</span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {idx < SYNC_GROUPS.length - 1 && (
                      <div className="h-px bg-gray-200 mt-3" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── Force re-sync toggle ────────────────────────────────────── */}
            <div className="mt-3 pt-3 border-t border-gray-100 shrink-0 flex flex-col gap-2">
              <label className="flex items-center gap-2 cursor-pointer select-none group/force">
                <input
                  type="checkbox"
                  className="w-3.5 h-3.5 accent-orange-500 shrink-0"
                  checked={forceResync}
                  onChange={(e) => setForceResync(e.target.checked)}
                />
                <span className={`text-sm font-medium ${forceResync ? "text-orange-700" : "text-gray-700 group-hover/force:text-gray-900"}`}>
                  Force re-sync
                </span>
                <div className="relative group/force-tip flex items-center ml-0.5">
                  <svg
                    className="w-3 h-3 text-gray-400 hover:text-gray-600 cursor-default transition-colors shrink-0"
                    viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                  >
                    <circle cx="8" cy="8" r="6.75" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7.5v3.5" />
                    <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
                  </svg>
                  <div className="pointer-events-none absolute left-0 top-full mt-2 w-52 bg-gray-900 text-white text-[11px] leading-relaxed rounded-lg px-3 py-2 shadow-xl opacity-0 group-hover/force-tip:opacity-100 transition-opacity duration-150 z-[1100]">
                    Re-fetch all data from Shopify, bypassing the local in-memory cache. Use after making changes in Shopify Admin or to repair missing source text. Does not affect the backup snapshot.
                    <span className="absolute left-2 bottom-full w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-gray-900" />
                  </div>
                </div>
              </label>

              {/* ── Overwrite backup toggle ──────────────────────────────────── */}
              <label className="flex items-center gap-2 cursor-pointer select-none group/fbackup">
                <input
                  type="checkbox"
                  className="w-3.5 h-3.5 accent-amber-500 shrink-0"
                  checked={forceBackup}
                  onChange={(e) => setForceBackup(e.target.checked)}
                />
                <span className={`text-sm font-medium ${forceBackup ? "text-amber-700" : "text-gray-700 group-hover/fbackup:text-gray-900"}`}>
                  Overwrite backup
                </span>
                <div className="relative group/fbackup-tip flex items-center ml-0.5">
                  <svg
                    className="w-3 h-3 text-gray-400 hover:text-gray-600 cursor-default transition-colors shrink-0"
                    viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                  >
                    <circle cx="8" cy="8" r="6.75" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7.5v3.5" />
                    <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
                  </svg>
                  <div className="pointer-events-none absolute left-0 top-full mt-2 w-52 bg-gray-900 text-white text-[11px] leading-relaxed rounded-lg px-3 py-2 shadow-xl opacity-0 group-hover/fbackup-tip:opacity-100 transition-opacity duration-150 z-[1100]">
                    Replace the stored backup snapshot with translations from this sync. Use when your translations have changed since the last backup and you want the Restore button to return to the current state.
                    <span className="absolute left-2 bottom-full w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-gray-900" />
                  </div>
                </div>
              </label>
            </div>

            <button
              type="button"
              onClick={() => {
                setShowTypes(false);
                onSync(
                  (forceResync || forceBackup)
                    ? { ...(forceResync ? { force: true } : {}), ...(forceBackup ? { forceBackup: true } : {}) }
                    : undefined
                );
              }}
              disabled={disabled || syncing}
              className={`mt-3 shrink-0 w-full rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                disabled || syncing
                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                  : forceResync
                    ? "bg-orange-600 text-white border-orange-600 hover:bg-orange-700"
                    : forceBackup
                      ? "bg-amber-500 text-white border-amber-500 hover:bg-amber-600"
                      : "bg-[#008060] text-white border-[#008060] hover:bg-[#006e52]"
              }`}
            >
              {forceResync && forceBackup ? "⟳ Force re-sync + overwrite backup"
                : forceResync ? "⟳ Force re-sync"
                : forceBackup ? "⟳ Sync + overwrite backup"
                : "Run sync"}
            </button>

            {/* ── Sub-item tooltips — panel-relative absolute, overflow scroll container freely ── */}
            {optionsTip && (
              <div
                className="pointer-events-none absolute w-52 bg-gray-900 text-white text-[11px] leading-snug rounded-lg px-3 py-2 shadow-xl z-[1100]"
                style={{ top: optionsTip.top, left: optionsTip.left, transform: "translateX(-50%)" }}
              >
                Option values like &apos;Red&apos; or &apos;Small&apos; are shared across all products. Translating them affects every product using that value.
                <span className="absolute left-1/2 -translate-x-1/2 bottom-full w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-gray-900" />
              </div>
            )}
            {policyTip && (
              <div
                className="pointer-events-none absolute w-52 bg-gray-900 text-white text-[11px] leading-snug rounded-lg px-3 py-2 shadow-xl z-[1100]"
                style={{ top: policyTip.top, left: policyTip.left, transform: "translateX(-50%)" }}
              >
                Covers: Refund policy, Privacy policy, Terms of service, Shipping policy, Legal notice, Subscription policy
                <span className="absolute left-1/2 -translate-x-1/2 bottom-full w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-gray-900" />
              </div>
            )}
            {mediaImagesTip && (
              <div
                className="pointer-events-none absolute w-52 bg-gray-900 text-white text-[11px] leading-snug rounded-lg px-3 py-2 shadow-xl z-[1100]"
                style={{ top: mediaImagesTip.top, left: mediaImagesTip.left, transform: "translateX(-50%)" }}
              >
                Translates alt text for every product image. Each image is a separate MEDIA_IMAGE resource in Shopify&apos;s Translations API.
                <span className="absolute left-1/2 -translate-x-1/2 bottom-full w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-gray-900" />
              </div>
            )}

            {/* ── About Markets & Pricing — collapsed disclosure ── */}
            <div className="mt-2 pt-2 border-t border-gray-100 shrink-0">
              <button
                type="button"
                onClick={() => setShowMarketsInfo((v) => !v)}
                className="flex items-center gap-1.5 w-full text-left text-[11px] text-gray-400 hover:text-gray-500 transition-colors"
                aria-expanded={showMarketsInfo}
              >
                {/* ℹ icon */}
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <circle cx="8" cy="8" r="6.75" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7.5v3.5" />
                  <circle cx="8" cy="5.25" r="0.6" fill="currentColor" stroke="none" />
                </svg>
                <span className="flex-1">About translations &amp; markets</span>
                {/* chevron */}
                <svg
                  className={`w-2.5 h-2.5 shrink-0 transition-transform ${showMarketsInfo ? "rotate-180" : ""}`}
                  viewBox="0 0 16 16" fill="currentColor" aria-hidden
                >
                  <path d="M4 6l4 4 4-4H4z" />
                </svg>
              </button>

              {showMarketsInfo && (
                <ul className="mt-2 space-y-1.5 text-[11px] text-gray-500 leading-snug">
                  <li className="flex gap-1.5">
                    <span className="shrink-0 text-gray-300">·</span>
                    <span>Prices, currencies, and formatting are managed by <strong className="font-medium text-gray-600">Shopify Markets</strong> — not this app.</span>
                  </li>
                  <li className="flex gap-1.5">
                    <span className="shrink-0 text-gray-300">·</span>
                    <span>Product availability by region is controlled by your Shopify Markets settings.</span>
                  </li>
                  <li className="flex gap-1.5">
                    <span className="shrink-0 text-gray-300">·</span>
                    <span>Translatable content: products, collections, pages, metafields, and theme text strings are supported.</span>
                  </li>
                  <li className="flex gap-1.5">
                    <span className="shrink-0 text-gray-300">·</span>
                    <span><strong className="font-medium text-gray-600">Shopify Checkout</strong> translation requires Shopify Plus — those strings are excluded from sync automatically.</span>
                  </li>
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Locale picker — shown only when locales are loaded */}
      {shopLocales.length === 1 && (
        <span
          className="inline-flex items-center gap-1 px-2 py-2.5 md:py-0.5 text-xs rounded-md bg-gray-50 border border-gray-200 text-gray-600 font-medium shrink-0"
          title={`Syncing into: ${shopLocales[0].name} (${shopLocales[0].locale})`}
        >
          {shopLocales[0].name}
          {!shopLocales[0].published && (
            <span className="text-amber-400 ml-0.5" title="Unpublished locale">⚠</span>
          )}
        </span>
      )}
      {shopLocales.length > 1 && (
        <select
          value={activeLocale}
          onChange={(e) => handleLocaleChange(e.target.value)}
          disabled={syncing}
          className="px-2 py-2.5 md:py-0.5 text-xs border border-gray-200 rounded-md bg-gray-50 text-gray-600 font-medium focus:outline-none focus:ring-1 focus:ring-gray-300 shrink-0 disabled:opacity-50"
          title="Target language for this sync run"
          aria-label="Target language"
        >
          {shopLocales.map((l) => (
            <option key={l.locale} value={l.locale}>
              {l.name} ({l.locale}){!l.published ? " ⚠" : ""}
            </option>
          ))}
        </select>
      )}

      {showLastSynced && (
        <span
          className="hidden sm:inline text-xs text-gray-500 tabular-nums whitespace-nowrap overflow-hidden text-ellipsis max-w-[24rem]"
          title={lastSyncAt ?? undefined}
        >
          Last synced:{relative != null ? ` ${relative}` : " —"}
          {lastSyncLabels != null && lastSyncLabels.length > 0 ? ` · ${lastSyncLabels.join(", ")}` : ""}
        </span>
      )}
    </div>
  );
}
