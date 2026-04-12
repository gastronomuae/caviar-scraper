"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { TranslationRecord, TranslationField, TranslateRunResult } from "@/types";
import { deriveRecordStatus } from "@/utils/csvParser";
import { deriveTranslationStatus } from "@/utils/translationStatus";
import { canPushTranslationRecord } from "@/utils/pushEligibility";
import { loadSettings } from "@/lib/settingsStorage";
import { readActiveLocale } from "@/lib/activeLocaleStorage";
import { isEffectivelyEmpty } from "@/utils/isEffectivelyEmpty";
import { translateFields } from "@/utils/openai";
import {
  groupThemeFields,
  humanizeSettingKey,
  pageContextLabel,
  type ThemePageGroup,
} from "@/utils/themeUtils";
import { AppButton, BackButton, TypeChip, MissingBadge, UnsavedBadge, Spinner as UiSpinner } from "@/components/ui";

/** Converts a pageContext string into a DOM-safe anchor ID (for page group headers). */
function pageContextToAnchorId(ctx: string): string {
  return "theme-sec-" + ctx.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

/** Stable DOM id for an individual section div (used for jump-scroll). */
function sectionAnchorId(pageContext: string, sectionId: string | null): string {
  const raw = `${pageContext}--${sectionId ?? "__top__"}`;
  return "theme-s-" + raw.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

// ── Two-level cascading filter toolbar ───────────────────────────────────────

interface SectionOption {
  pageContext: string;
  sectionId: string | null;
  label: string;
  pageLabel: string;
  anchorId: string;
  missingCount: number;
  fieldCount: number;
}

/** Small reusable dropdown (no search) used for Level-1 page context. */
function SimpleDropdown({
  trigger,
  children,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          className="absolute left-0 top-full mt-1.5 z-50 bg-white border border-gray-200 rounded-xl shadow-lg min-w-[220px] overflow-hidden"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ThemeFilterBar({
  sectionOptions,
  showMissingOnly,
  onShowMissingOnlyChange,
  selectedPageCtx,
  onPageCtxChange,
}: {
  sectionOptions: SectionOption[];
  showMissingOnly: boolean;
  onShowMissingOnlyChange: (v: boolean) => void;
  selectedPageCtx: string | null;
  onPageCtxChange: (ctx: string | null) => void;
}) {
  const [l2Open, setL2Open] = useState(false);
  const [l2Query, setL2Query] = useState("");
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const l2Ref = useRef<HTMLDivElement>(null);
  const l2InputRef = useRef<HTMLInputElement>(null);

  // ── Level-1 options: unique page contexts ────────────────────────────────
  const pageCtxOptions = useMemo(() => {
    const map = new Map<string, { label: string; missingCount: number }>();
    for (const o of sectionOptions) {
      if (!map.has(o.pageContext))
        map.set(o.pageContext, { label: o.pageLabel, missingCount: 0 });
      map.get(o.pageContext)!.missingCount += o.missingCount;
    }
    // When showMissingOnly, hide contexts with no missing
    return [...map.entries()]
      .filter(([, v]) => !showMissingOnly || v.missingCount > 0)
      .map(([ctx, { label, missingCount }]) => ({ ctx, label, missingCount }));
  }, [sectionOptions, showMissingOnly]);

  // ── Level-2 options: sections in selected context ─────────────────────────
  const l2Base = useMemo(() => {
    let opts = sectionOptions;
    if (selectedPageCtx !== null) opts = opts.filter((o) => o.pageContext === selectedPageCtx);
    if (showMissingOnly) opts = opts.filter((o) => o.missingCount > 0);
    return opts;
  }, [sectionOptions, selectedPageCtx, showMissingOnly]);

  const l2Filtered = useMemo(() => {
    const q = l2Query.toLowerCase().trim();
    if (!q) return l2Base;
    return l2Base.filter(
      (o) => o.label.toLowerCase().includes(q) || o.pageLabel.toLowerCase().includes(q)
    );
  }, [l2Base, l2Query]);

  // Close L2 on outside click
  useEffect(() => {
    if (!l2Open) return;
    function h(e: MouseEvent) {
      if (l2Ref.current && !l2Ref.current.contains(e.target as Node)) {
        setL2Open(false);
        setL2Query("");
      }
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [l2Open]);

  function openL2() {
    setL2Open(true);
    setTimeout(() => l2InputRef.current?.focus(), 40);
  }

  function selectSection(opt: SectionOption) {
    setActiveAnchor(opt.anchorId);
    setL2Open(false);
    setL2Query("");
    const scrollEl = document.getElementById("theme-editor-scroll");
    const target = document.getElementById(opt.anchorId);
    if (target && scrollEl) {
      const top = target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
      scrollEl.scrollBy({ top: top - 80, behavior: "smooth" });
    }
  }

  const activeL2 = sectionOptions.find((o) => o.anchorId === activeAnchor);
  const activePageCtxLabel = pageCtxOptions.find((o) => o.ctx === selectedPageCtx)?.label;

  // Chevron icon
  function Chevron({ open: o }: { open: boolean }) {
    return (
      <svg className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${o ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    );
  }

  const btnBase = "flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs text-gray-700 hover:border-gray-300 hover:bg-gray-50 transition-colors shadow-sm";

  return (
    <div className="flex items-center gap-2 flex-wrap">

      {/* ── Level 1: page context ─────────────────────────────────────────── */}
      <SimpleDropdown
        trigger={
          <button type="button" className={`${btnBase} min-w-[148px]`}>
            <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h18M3 12h18M3 17h18" />
            </svg>
            <span className="flex-1 text-left truncate">
              {activePageCtxLabel ?? "All pages"}
            </span>
            <Chevron open={false} />
          </button>
        }
      >
        <ul className="max-h-72 overflow-y-auto py-1">
          {/* "All pages" option */}
          <li>
            <button
              type="button"
              onClick={() => { onPageCtxChange(null); setActiveAnchor(null); setL2Query(""); }}
              className={`w-full flex items-center justify-between px-4 py-2 text-left text-sm hover:bg-gray-50 transition-colors
                ${selectedPageCtx === null ? "bg-blue-50 font-semibold text-blue-700" : "text-gray-700"}`}
            >
              All pages
            </button>
          </li>
          <li><div className="border-t border-gray-100 my-1" /></li>
          {pageCtxOptions.map(({ ctx, label, missingCount }) => (
            <li key={ctx}>
              <button
                type="button"
                onClick={() => { onPageCtxChange(ctx); setActiveAnchor(null); setL2Query(""); }}
                className={`w-full flex items-center justify-between gap-2 px-4 py-2 text-left hover:bg-gray-50 transition-colors
                  ${selectedPageCtx === ctx ? "bg-blue-50" : ""}`}
              >
                <span className={`text-sm truncate ${selectedPageCtx === ctx ? "font-semibold text-blue-700" : "text-gray-700"}`}>
                  {label}
                </span>
                {missingCount > 0 ? (
                  <span className="shrink-0 text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                    {missingCount} missing
                  </span>
                ) : (
                  <span className="shrink-0 text-[10px] font-medium text-green-600">✓</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </SimpleDropdown>

      {/* ── Level 2: section (searchable) ────────────────────────────────── */}
      <div ref={l2Ref} className="relative">
        <button
          type="button"
          onClick={l2Open ? () => { setL2Open(false); setL2Query(""); } : openL2}
          className={`${btnBase} min-w-[180px] max-w-[280px]`}
        >
          <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h16" />
          </svg>
          <span className="flex-1 text-left truncate">
            {activeL2 ? activeL2.label : "All sections"}
          </span>
          <Chevron open={l2Open} />
        </button>

        {l2Open && (
          <div className="absolute left-0 top-full mt-1.5 z-50 bg-white border border-gray-200 rounded-xl shadow-lg w-80 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100">
              <input
                ref={l2InputRef}
                type="text"
                value={l2Query}
                onChange={(e) => setL2Query(e.target.value)}
                placeholder="Search sections…"
                className="w-full text-sm px-2 py-1.5 rounded-md border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent"
              />
            </div>
            <ul className="max-h-72 overflow-y-auto py-1">
              {l2Filtered.length === 0 && (
                <li className="px-4 py-3 text-xs text-gray-400 italic">No sections match</li>
              )}
              {l2Filtered.map((opt) => (
                <li key={opt.anchorId}>
                  <button
                    type="button"
                    onClick={() => selectSection(opt)}
                    className={`w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-50 transition-colors
                      ${activeAnchor === opt.anchorId ? "bg-blue-50" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-gray-800 truncate block">{opt.label}</span>
                      {selectedPageCtx === null && (
                        <span className="text-[10px] text-gray-400 truncate block">{opt.pageLabel}</span>
                      )}
                    </div>
                    {opt.missingCount > 0 ? (
                      <span className="shrink-0 text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                        {opt.missingCount} missing
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] font-medium text-green-600">✓</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Missing only checkbox ─────────────────────────────────────────── */}
      <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0">
        <input
          type="checkbox"
          checked={showMissingOnly}
          onChange={(e) => onShowMissingOnlyChange(e.target.checked)}
          className="w-3.5 h-3.5 rounded border-gray-300 cursor-pointer accent-amber-500"
        />
        <span className={`text-xs font-medium ${showMissingOnly ? "text-amber-600" : "text-gray-500"}`}>
          Missing only
        </span>
      </label>
    </div>
  );
}

// ── Pending changes drawer ────────────────────────────────────────────────────

interface ChangedItem {
  fieldKey: string;
  sectionLabel: string;
  pageLabel: string;
  fieldLabel: string;
  originalValue: string;
  currentValue: string;
}

function PendingChangesDrawer({
  isOpen,
  onClose,
  items,
  onUndoField,
  onPushAll,
  onDiscardAll,
  isPushing,
}: {
  isOpen: boolean;
  onClose: () => void;
  items: ChangedItem[];
  onUndoField: (key: string) => void;
  onPushAll: () => void;
  onDiscardAll: () => void;
  isPushing: boolean;
}) {
  if (!isOpen) return null;

  // Group items by section
  const grouped: [string, ChangedItem[]][] = [];
  const seen = new Map<string, ChangedItem[]>();
  for (const item of items) {
    const gk = `${item.pageLabel} · ${item.sectionLabel}`;
    if (!seen.has(gk)) { seen.set(gk, []); grouped.push([gk, seen.get(gk)!]); }
    seen.get(gk)!.push(item);
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px]"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-[520px] z-50 bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Pending changes</h2>
            <p className="text-xs text-gray-500 mt-0.5">{items.length} field{items.length !== 1 ? "s" : ""} not pushed</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 transition-colors p-1 rounded-md hover:bg-gray-100"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable list */}
        <div className="flex-1 overflow-y-auto py-3 px-5 space-y-5">
          {grouped.map(([groupLabel, groupItems]) => (
            <div key={groupLabel}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">{groupLabel}</p>
              <div className="space-y-2">
                {groupItems.map((item) => (
                  <div key={item.fieldKey} className="rounded-xl border border-amber-200 bg-amber-50/40 overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-1.5 bg-amber-50 border-b border-amber-100">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">{item.fieldLabel}</span>
                      <button
                        onClick={() => onUndoField(item.fieldKey)}
                        className="text-[11px] text-gray-500 hover:text-red-600 hover:bg-red-50 px-2 py-0.5 rounded border border-transparent hover:border-red-200 transition-colors"
                      >
                        Undo
                      </button>
                    </div>
                    <div className="px-3 py-2 space-y-1.5">
                      {item.originalValue ? (
                        <div className="flex gap-2 items-start">
                          <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide w-10 shrink-0 mt-0.5">Before</span>
                          <p className="text-xs text-gray-400 line-through leading-relaxed">{item.originalValue}</p>
                        </div>
                      ) : (
                        <div className="flex gap-2 items-start">
                          <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide w-10 shrink-0 mt-0.5">Before</span>
                          <p className="text-xs text-gray-300 italic">empty</p>
                        </div>
                      )}
                      <div className="flex gap-2 items-start">
                        <span className="text-[10px] font-medium text-green-600 uppercase tracking-wide w-10 shrink-0 mt-0.5">After</span>
                        <p className="text-xs text-gray-800 leading-relaxed">{item.currentValue}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <span className="text-3xl">✓</span>
              <p className="text-sm text-gray-500">No pending changes</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 px-5 py-4 flex items-center gap-3 shrink-0 bg-gray-50">
          <button
            onClick={onPushAll}
            disabled={isPushing || items.length === 0}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all
              ${isPushing || items.length === 0
                ? "bg-[#008060]/60 text-white cursor-not-allowed border border-[#008060]/40"
                : "bg-[#008060] text-white border border-[#008060] hover:bg-[#006e52] shadow-sm"
              }`}
          >
            {isPushing ? "Publishing…" : `Publish all ${items.length}`}
          </button>
          <button
            onClick={onDiscardAll}
            disabled={isPushing}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold text-red-600 bg-white border border-red-200 hover:bg-red-50 transition-all disabled:opacity-40"
          >
            Discard all
          </button>
        </div>
      </div>
    </>
  );
}

// ── Icons (inline SVG to avoid extra deps) ───────────────────────────────────

function BackIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  return <UiSpinner className={size === "sm" ? "w-3 h-3" : "w-4 h-4"} />;
}

function TranslateIcon({ size = "sm" }: { size?: "xs" | "sm" }) {
  const cls = size === "xs" ? "w-3 h-3" : "w-4 h-4";
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
    </svg>
  );
}

function RefreshIcon({ size = "sm" }: { size?: "xs" | "sm" }) {
  const cls = size === "xs" ? "w-3 h-3" : "w-4 h-4";
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

function FieldStatusDot({ status }: { status: TranslationField["status"] }) {
  const colors = { done: "bg-green-400", outdated: "bg-orange-400", missing: "bg-gray-300" };
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[status]}`} title={status} />;
}

/** Collapses plain-text source content to 4 lines when it's long, with a toggle. */
const COLLAPSE_THRESHOLD = 300;
function CollapsibleSource({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span className="text-gray-300 italic text-xs">empty</span>;
  const isLong = text.length > COLLAPSE_THRESHOLD;
  return (
    <div>
      <p
        className={`text-sm text-gray-700 whitespace-pre-wrap leading-relaxed ${
          isLong && !expanded ? "line-clamp-4" : ""
        }`}
      >
        {text}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ── Page-context badge colours ────────────────────────────────────────────────

const PAGE_BADGE_COLOR: Record<string, string> = {
  "/": "bg-indigo-50 text-indigo-700 border-indigo-200",
  "/products/*": "bg-blue-50 text-blue-700 border-blue-200",
  "/collections/*": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "/blogs/*": "bg-amber-50 text-amber-700 border-amber-200",
  "/blogs/*/articles/*": "bg-orange-50 text-orange-700 border-orange-200",
  "/cart": "bg-yellow-50 text-yellow-700 border-yellow-200",
  "/checkout": "bg-purple-50 text-purple-700 border-purple-200",
  "/account/*": "bg-sky-50 text-sky-700 border-sky-200",
  "/search": "bg-teal-50 text-teal-700 border-teal-200",
  "/pages/contact-us": "bg-rose-50 text-rose-700 border-rose-200",
  "/gift_cards/*": "bg-pink-50 text-pink-700 border-pink-200",
  "/password": "bg-slate-100 text-slate-600 border-slate-200",
  "/404": "bg-red-50 text-red-700 border-red-200",
  "/pages/faq": "bg-violet-50 text-violet-700 border-violet-200",
  "/pages/about": "bg-cyan-50 text-cyan-700 border-cyan-200",
  "/pages/wishlist": "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  "/pages/privacy-policy": "bg-gray-50 text-gray-600 border-gray-300",
  "/pages/return-policy": "bg-gray-50 text-gray-600 border-gray-300",
  "/pages/shipping-policy": "bg-gray-50 text-gray-600 border-gray-300",
  "/pages/terms-conditions": "bg-gray-50 text-gray-600 border-gray-300",
  "/pages/payment-policy": "bg-gray-50 text-gray-600 border-gray-300",
  "apps": "bg-lime-50 text-lime-700 border-lime-200",
  "shopify-system": "bg-slate-100 text-slate-500 border-slate-200",
  "theme-wide": "bg-gray-100 text-gray-600 border-gray-200",
};
function pageBadgeColor(ctx: string) {
  return PAGE_BADGE_COLOR[ctx] ?? "bg-slate-100 text-slate-600 border-slate-200";
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ThemeEditorProps {
  record: TranslationRecord;
  recordIndex: number;
  totalRecords: number;
  onSave: (updated: TranslationRecord) => void;
  onTranslate: (id: string, skipExisting?: boolean) => Promise<TranslateRunResult>;
  onPushedToShopify?: (recordId: string) => void;
  onBack: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  layout?: "page" | "panel";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ThemeEditor({
  record,
  recordIndex,
  totalRecords,
  onSave,
  onTranslate,
  onPushedToShopify,
  onBack,
  onNavigate,
  layout = "page",
}: ThemeEditorProps) {
  // draft state: fieldKey → en_content
  const [drafts, setDrafts] = useState<Record<string, string>>(
    () => Object.fromEntries(record.fields.map((f) => [f.field, f.en_content ?? ""]))
  );
  const [isDirty, setIsDirty] = useState(false);
  const [translatingField, setTranslatingField] = useState<string | null>(null);
  const [pushState, setPushState] = useState<"idle" | "pushing" | "ok" | "error">("idle");
  const [pushMessage, setPushMessage] = useState("");

  // Collapse state per section (key = `${pageCtx}__${sectionId}`)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Per-section push state: secKey → "idle" | "pushing" | "ok" | "error"
  type SectionActionState = "idle" | "pushing" | "ok" | "error";
  const [sectionPush, setSectionPush] = useState<Record<string, SectionActionState>>({});
  // Per-section translate state: Set of secKeys currently being AI-translated
  const [sectionTranslating, setSectionTranslating] = useState<Set<string>>(new Set());
  // Filter state — both reset on navigation (not persisted)
  const [showMissingOnly, setShowMissingOnly] = useState(false);
  const [selectedPageCtx, setSelectedPageCtx] = useState<string | null>(null);

  // Snapshot of translation values at load time — used for changed detection + drawer
  const originalValues = useRef<Record<string, string>>(
    Object.fromEntries(record.fields.map((f) => [f.field, f.en_content ?? ""]))
  );

  // Per-field undo history: key → stack of previous values (oldest first)
  const undoStack = useRef<Record<string, string[]>>(
    (() => {
      try {
        const stored = sessionStorage.getItem(`theme_undo_${record.id}`);
        return stored ? (JSON.parse(stored) as Record<string, string[]>) : {};
      } catch { return {}; }
    })()
  );

  // Persist undo stack to sessionStorage (called after every mutation)
  function persistUndoStack() {
    try {
      const data = undoStack.current;
      if (Object.keys(data).length > 0) {
        sessionStorage.setItem(`theme_undo_${recordRef.current?.id ?? record.id}`, JSON.stringify(data));
      } else {
        sessionStorage.removeItem(`theme_undo_${recordRef.current?.id ?? record.id}`);
      }
    } catch { /* quota exceeded — ignore */ }
  }

  const [drawerOpen, setDrawerOpen] = useState(false);
  // Set of field keys flashing green briefly after a push
  const [pushFlash, setPushFlash] = useState<Set<string>>(new Set());
  // Push-limit info banner — shown once per session, dismissible
  const [pushBannerDismissed, setPushBannerDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem("theme_push_banner_dismissed") === "1"; }
    catch { return false; }
  });

  // ── Dirty-field tracking (persisted in sessionStorage per resource) ───────
  const dirtySessionKey = `theme_dirty_${record.id}`;
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(() => {
    try {
      const stored = sessionStorage.getItem(`theme_dirty_${record.id}`);
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });

  // Persist dirty fields to sessionStorage whenever they change
  useEffect(() => {
    try {
      if (dirtyFields.size > 0) {
        sessionStorage.setItem(dirtySessionKey, JSON.stringify([...dirtyFields]));
      } else {
        sessionStorage.removeItem(dirtySessionKey);
      }
    } catch { /* storage quota exceeded – ignore */ }
  }, [dirtyFields, dirtySessionKey]);

  // Reload dirty + undo state when record changes (navigating between themes)
  const prevRecordId = useRef(record.id);
  useEffect(() => {
    if (prevRecordId.current === record.id) return;
    prevRecordId.current = record.id;
    try {
      const stored = sessionStorage.getItem(`theme_dirty_${record.id}`);
      setDirtyFields(stored ? new Set(JSON.parse(stored) as string[]) : new Set());
    } catch { setDirtyFields(new Set()); }
    try {
      const stored = sessionStorage.getItem(`theme_undo_${record.id}`);
      undoStack.current = stored ? (JSON.parse(stored) as Record<string, string[]>) : {};
    } catch { undoStack.current = {}; }
    // Reset original values snapshot for new record
    originalValues.current = Object.fromEntries(
      record.fields.map((f) => [f.field, f.en_content ?? ""])
    );
  }, [record.id, record.fields]);

  const recordRef = useRef(record);
  recordRef.current = record;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Sync drafts after external translation completes
  useEffect(() => {
    if (!record.isTranslating && !isDirty) {
      setDrafts(Object.fromEntries(record.fields.map((f) => [f.field, f.en_content ?? ""])));
    }
    if (!record.isTranslating && isDirty) {
      setDrafts((prev) =>
        Object.fromEntries(
          record.fields.map((f) => [
            f.field,
            prev[f.field] ?? f.en_content ?? "",
          ])
        )
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.isTranslating]);

  const updateDraft = useCallback((fieldKey: string, value: string) => {
    // Capture current value before overwriting — push onto per-field undo stack
    const before = draftsRef.current[fieldKey] ?? "";
    undoStack.current[fieldKey] = [...(undoStack.current[fieldKey] ?? []), before];
    persistUndoStack();
    setDrafts((prev) => ({ ...prev, [fieldKey]: value }));
    setDirtyFields((prev) => new Set(prev).add(fieldKey));
    setIsDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced auto-save — mirrors ProductEditor behaviour.
  // Fires 900 ms after any draft change while isDirty is true.
  useEffect(() => {
    if (!isDirty) return;
    const t = window.setTimeout(() => {
      const currentDrafts = draftsRef.current;
      const rec = recordRef.current;
      const updatedFields: TranslationField[] = rec.fields.map((f) => {
        const en = currentDrafts[f.field] ?? f.en_content ?? "";
        return { ...f, en_content: en, status: en.trim() ? ("done" as const) : ("missing" as const) };
      });
      onSave({
        ...rec,
        fields: updatedFields,
        status: deriveRecordStatus(updatedFields),
        translation_status: deriveTranslationStatus(updatedFields),
      });
      setIsDirty(false);
    }, 900);
    return () => clearTimeout(t);
  }, [drafts, isDirty, onSave]);

  function handleSave() {
    const updatedFields: TranslationField[] = record.fields.map((f) => {
      const en = drafts[f.field] ?? f.en_content ?? "";
      return {
        ...f,
        en_content: en,
        status: en.trim() ? "done" : "missing",
      };
    });
    const updated: TranslationRecord = {
      ...record,
      fields: updatedFields,
      status: deriveRecordStatus(updatedFields),
      translation_status: deriveTranslationStatus(updatedFields),
    };
    onSave(updated);
    setIsDirty(false);
  }

  async function handlePush() {
    setPushState("pushing");
    try {
      const settings = loadSettings();
      const fields = record.fields
        .filter((f) => f.field !== "__display_title__")
        .map((f) => ({ key: f.field, value: drafts[f.field] ?? f.en_content ?? "" }))
        .filter((f) => !isEffectivelyEmpty(f.value));
      if (!fields.length) {
        setPushState("error");
        setPushMessage("No translated content to push.");
        setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 4000);
        return;
      }
      const res = await fetch("/api/shopify/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopifyDomain: settings.shopifyDomain,
          resourceId: record.identification,
          resourceType: record.type,
          locale: record.locale,
          fields,
        }),
      });
      const data = (await res.json()) as { pushed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPushState("ok");
      setPushMessage(`Pushed ${data.pushed ?? fields.length} field${(data.pushed ?? fields.length) !== 1 ? "s" : ""}`);
      onPushedToShopify?.(record.id);
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 5000);
    } catch (e) {
      setPushState("error");
      setPushMessage(e instanceof Error ? e.message : "Push failed");
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 8000);
    }
  }

  async function handleSmartPush() {
    // When there are tracked dirty fields — push only those (smart/selective push).
    // When nothing is dirty (e.g. first session open, after a page reload) — fall back
    // to pushing all translated content, preserving the original "Push to Shopify" behaviour.
    const dirtyKeys = [...dirtyFields].filter((k) => k !== "__display_title__");
    const toPush = dirtyKeys.length > 0
      ? dirtyKeys
          .map((k) => ({ key: k, value: drafts[k] ?? "" }))
          .filter((f) => !isEffectivelyEmpty(f.value))
      : record.fields
          .filter((f) => f.field !== "__display_title__")
          .map((f) => ({ key: f.field, value: drafts[f.field] ?? f.en_content ?? "" }))
          .filter((f) => !isEffectivelyEmpty(f.value));
    if (!toPush.length) return;

    setPushState("pushing");
    try {
      const settings = loadSettings();
      const CHUNK = 250;
      let totalPushed = 0;
      for (let i = 0; i < toPush.length; i += CHUNK) {
        const chunk = toPush.slice(i, i + CHUNK);
        const res = await fetch("/api/shopify/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shopifyDomain: settings.shopifyDomain,
            resourceId: record.identification,
            resourceType: record.type,
            locale: record.locale,
            fields: chunk,
          }),
        });
        const data = (await res.json()) as { pushed?: number; error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        totalPushed += data.pushed ?? chunk.length;
      }
      const pushedKeys = toPush.map((f) => f.key);
      // Update originalValues to reflect what was just pushed
      pushedKeys.forEach((k) => { originalValues.current[k] = drafts[k] ?? ""; });
      // Clear dirty + undo stack for pushed keys
      setDirtyFields((prev) => {
        const next = new Set(prev);
        pushedKeys.forEach((k) => next.delete(k));
        return next;
      });
      pushedKeys.forEach((k) => delete undoStack.current[k]);
      persistUndoStack();
      // Flash green on pushed field cards, then clear
      setPushFlash(new Set(pushedKeys));
      setTimeout(() => setPushFlash(new Set()), 2000);
      setDrawerOpen(false);
      setPushState("ok");
      setPushMessage(`Pushed ${totalPushed} field${totalPushed !== 1 ? "s" : ""}`);
      onPushedToShopify?.(record.id);
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 5000);
    } catch (e) {
      setPushState("error");
      setPushMessage(e instanceof Error ? e.message : "Push failed");
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 8000);
    }
  }

  // Pop last value from a field's undo stack (called by per-field Undo button)
  function handlePopUndo(key: string) {
    const stack = undoStack.current[key];
    if (!stack?.length) return;
    const restored = stack[stack.length - 1];
    undoStack.current[key] = stack.slice(0, -1);
    persistUndoStack();
    setDrafts((prev) => ({ ...prev, [key]: restored }));
    // If we've gone back to the original value, remove from dirtyFields
    if ((restored ?? "") === (originalValues.current[key] ?? "") && undoStack.current[key].length === 0) {
      setDirtyFields((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }

  // Revert all dirty fields to load-time originals (called by "Undo all" header button)
  function handleUndoAll() {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const key of dirtyFields) next[key] = originalValues.current[key] ?? "";
      return next;
    });
    for (const key of dirtyFields) delete undoStack.current[key];
    persistUndoStack();
    setDirtyFields(new Set());
  }

  // Revert to originalValues[key] (called from drawer "Undo this" button — reverts to load-time, not last edit)
  function handleUndoField(key: string) {
    const orig = originalValues.current[key] ?? "";
    delete undoStack.current[key];
    persistUndoStack();
    setDrafts((prev) => ({ ...prev, [key]: orig }));
    setDirtyFields((prev) => { const next = new Set(prev); next.delete(key); return next; });
  }

  function handleDiscardAll() {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const key of dirtyFields) next[key] = originalValues.current[key] ?? "";
      return next;
    });
    for (const key of dirtyFields) delete undoStack.current[key];
    persistUndoStack();
    setDirtyFields(new Set());
    setDrawerOpen(false);
  }

  async function handleTranslateSingleField(field: TranslationField, force: boolean) {
    const ruContent = field.ru_content ?? "";
    const en = drafts[field.field] ?? field.en_content ?? "";
    // Match ProductEditor: skip only if content exists AND status is cleanly done
    if (!force && en.trim() && field.status === "done") return;

    setTranslatingField(field.field);
    try {
      const settings = loadSettings();
      const results = await translateFields(
        [{ key: field.field, text: ruContent, fieldType: field.fieldType }],
        { ...settings, targetLanguage: readActiveLocale(settings.shopifyDomain) }
      );
      const translation = results[0]?.translation;
      if (translation) updateDraft(field.field, translation);
    } catch (e) {
      console.error("Single field translation failed:", e);
    } finally {
      setTranslatingField(null);
    }
  }

  async function handlePushSection(secKey: string, sectionFields: TranslationField[]) {
    setSectionPush((prev) => ({ ...prev, [secKey]: "pushing" }));
    try {
      const settings = loadSettings();
      const fields = sectionFields
        .filter((f) => f.field !== "__display_title__")
        .map((f) => ({ key: f.field, value: drafts[f.field] ?? f.en_content ?? "" }))
        .filter((f) => !isEffectivelyEmpty(f.value));
      if (!fields.length) {
        setSectionPush((prev) => ({ ...prev, [secKey]: "error" }));
        setTimeout(() => setSectionPush((prev) => ({ ...prev, [secKey]: "idle" })), 3000);
        return;
      }
      if (fields.length > 250) {
        setSectionPush((prev) => ({ ...prev, [secKey]: "error" }));
        setPushMessage(
          `Section has ${fields.length} translated fields — Shopify allows max 250 per push. Filter to a smaller set first.`
        );
        setTimeout(() => {
          setSectionPush((prev) => ({ ...prev, [secKey]: "idle" }));
          setPushMessage("");
        }, 8000);
        return;
      }
      const res = await fetch("/api/shopify/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopifyDomain: settings.shopifyDomain,
          resourceId: record.identification,
          resourceType: record.type,
          locale: record.locale,
          fields,
        }),
      });
      const data = (await res.json()) as { pushed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // Update originalValues + clear dirty/undo for pushed section fields
      fields.forEach(({ key, value }) => { originalValues.current[key] = value; });
      setDirtyFields((prev) => {
        const next = new Set(prev);
        fields.forEach(({ key }) => next.delete(key));
        return next;
      });
      fields.forEach(({ key }) => delete undoStack.current[key]);
      persistUndoStack();
      setSectionPush((prev) => ({ ...prev, [secKey]: "ok" }));
      onPushedToShopify?.(record.id);
      setTimeout(() => setSectionPush((prev) => ({ ...prev, [secKey]: "idle" })), 4000);
    } catch (e) {
      console.error("[ThemeEditor] section push failed:", e);
      setSectionPush((prev) => ({ ...prev, [secKey]: "error" }));
      setTimeout(() => setSectionPush((prev) => ({ ...prev, [secKey]: "idle" })), 5000);
    }
  }

  async function handleTranslateMissingSection(secKey: string, sectionFields: TranslationField[]) {
    const missing = sectionFields.filter(
      (f) => f.ru_content?.trim() && isEffectivelyEmpty(drafts[f.field] ?? f.en_content ?? "")
    );
    if (!missing.length) return;
    setSectionTranslating((prev) => new Set(prev).add(secKey));
    try {
      const settings = loadSettings();
      const toTranslate = missing.map((f) => ({ key: f.field, text: f.ru_content!, fieldType: f.fieldType }));
      const results = await translateFields(toTranslate, { ...settings, targetLanguage: readActiveLocale(settings.shopifyDomain) });
      setDrafts((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r.translation) next[r.key] = r.translation;
        }
        return next;
      });
      const translatedKeys = results.filter((r) => r.translation).map((r) => r.key);
      if (translatedKeys.length > 0) {
        setDirtyFields((prev) => {
          const next = new Set(prev);
          translatedKeys.forEach((k) => next.add(k));
          return next;
        });
      }
      setIsDirty(true);
    } catch (e) {
      console.error("[ThemeEditor] section translate failed:", e);
    } finally {
      setSectionTranslating((prev) => {
        const next = new Set(prev);
        next.delete(secKey);
        return next;
      });
    }
  }

  // Grouped view — memoized so downstream useMemos get a stable reference
  const groups = useMemo<ThemePageGroup[]>(
    () => groupThemeFields(record.fields),
    [record.fields]
  );

  const missingCount = record.fields.filter(
    (f) => f.ru_content?.trim() && isEffectivelyEmpty(drafts[f.field] ?? f.en_content ?? "")
  ).length;

  /** Flat list of all sections across all page groups — drives the jump dropdown. */
  const sectionOptions = useMemo<SectionOption[]>(() => {
    const opts: SectionOption[] = [];
    for (const pg of groups) {
      for (const sec of pg.sections) {
        const fieldCount = sec.blocks.reduce((n, b) => n + b.entries.length, 0);
        const doneCount = sec.blocks.reduce(
          (n, b) =>
            n +
            b.entries.filter(
              (e) => !isEffectivelyEmpty(drafts[e.field.field] ?? e.field.en_content ?? "")
            ).length,
          0
        );
        opts.push({
          pageContext: pg.pageContext,
          sectionId: sec.sectionId,
          label: sec.label,
          pageLabel: pg.label,
          anchorId: sectionAnchorId(pg.pageContext, sec.sectionId),
          missingCount: fieldCount - doneCount,
          fieldCount,
        });
      }
    }
    return opts;
  }, [groups, drafts]);

  /** Flat list of fields that differ from their load-time snapshot — powers the drawer. */
  const changedItems = useMemo<ChangedItem[]>(() => {
    const items: ChangedItem[] = [];
    for (const pg of groups) {
      for (const sec of pg.sections) {
        for (const block of sec.blocks) {
          for (const { parsed, field } of block.entries) {
            const orig = originalValues.current[field.field] ?? "";
            const curr = drafts[field.field] ?? "";
            if (curr !== orig) {
              items.push({
                fieldKey: field.field,
                sectionLabel: sec.label,
                pageLabel: pg.label,
                fieldLabel: humanizeSettingKey(parsed.settingKey),
                originalValue: orig,
                currentValue: curr,
              });
            }
          }
        }
      }
    }
    return items;
  }, [groups, drafts, dirtyFields]);

  /** Applies page-context, missing-only, and changed-only filters for the body render. */
  const visibleGroups = useMemo<ThemePageGroup[]>(() => {
    let result = groups;
    // Level-1 filter: selected page context
    if (selectedPageCtx !== null) {
      result = result.filter((pg) => pg.pageContext === selectedPageCtx);
    }
    // Level-2 filter: missing only
    if (showMissingOnly) {
      result = result
        .map((pg) => ({
          ...pg,
          sections: pg.sections.filter((sec) =>
            sec.blocks.some((b) =>
              b.entries.some(
                (e) =>
                  e.field.ru_content?.trim() &&
                  isEffectivelyEmpty(drafts[e.field.field] ?? e.field.en_content ?? "")
              )
            )
          ),
        }))
        .filter((pg) => pg.sections.length > 0);
    }
    return result;
  }, [groups, showMissingOnly, selectedPageCtx, drafts, dirtyFields]);

  const isTranslating = record.isTranslating ?? false;
  const showPush = canPushTranslationRecord(record);

  /** Count of dirty fields that have non-empty content — drives the smart push button label. */
  const dirtyPushCount = useMemo(
    () =>
      [...dirtyFields].filter(
        (k) => k !== "__display_title__" && !isEffectivelyEmpty(drafts[k] ?? "")
      ).length,
    [dirtyFields, drafts]
  );

  const shellClass =
    layout === "panel"
      ? "min-h-0 h-full flex flex-col bg-slate-50 overflow-hidden"
      : "h-screen flex flex-col bg-slate-50 overflow-hidden";
  const headerPad = layout === "panel" ? "px-4 py-2.5" : "px-6 py-3";
  const mainPad = layout === "panel" ? "px-4 py-4" : "px-6 py-6";

  function toggleSection(key: string) {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div className={shellClass}>
      <PendingChangesDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={changedItems}
        onUndoField={handleUndoField}
        onPushAll={() => void handleSmartPush()}
        onDiscardAll={handleDiscardAll}
        isPushing={pushState === "pushing"}
      />
      {/* ── Sticky header ── */}
      <div className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10 shrink-0">
        <div className={`max-w-screen-xl mx-auto ${headerPad} flex flex-col gap-2`}>
          {/* ── Row 1: Navigation ── */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <BackButton onClick={onBack} />
            <span className="text-gray-200">|</span>
            <TypeChip label="Theme" />
            <span className="text-sm text-gray-700 font-medium truncate" title={record.handle}>
              {record.handle}
            </span>
            <MissingBadge count={missingCount} />
          </div>

          {/* ── Row 2: Actions ── */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Primary action — left */}
            <AppButton
              variant="translate"
              onClick={() => void onTranslate(record.id, missingCount > 0)}
              title={missingCount > 0 ? "Translate missing fields" : "Re-translate all fields"}
              loading={isTranslating}
              loadingText="Translating…"
            >
              <TranslateIcon />
              {missingCount > 0 ? "Translate missing" : "Re-translate"}
            </AppButton>

            {/* Secondary actions — right */}
            <div className="flex flex-wrap items-center gap-2">
              {isDirty && <UnsavedBadge />}

              {dirtyFields.size > 0 && pushState === "idle" && (
                <AppButton
                  variant="secondary"
                  onClick={handleUndoAll}
                  title={`Revert all ${dirtyFields.size} change${dirtyFields.size !== 1 ? "s" : ""} to original values`}
                >
                  ↩ Undo all
                </AppButton>
              )}

              <AppButton
                variant="secondary"
                onClick={handleSave}
                disabled={!isDirty}
              >
                Save
              </AppButton>

              {showPush && (
                <AppButton
                  variant="primary"
                  onClick={() => {
                    if (dirtyPushCount > 0) { setDrawerOpen(true); }
                    else { void handleSmartPush(); }
                  }}
                  loading={pushState === "pushing"}
                  loadingText="Publishing…"
                  title={dirtyPushCount > 0 ? `Review ${dirtyPushCount} pending change${dirtyPushCount !== 1 ? "s" : ""}` : "Publish all translated fields to Shopify"}
                >
                  {dirtyPushCount > 0 ? `Publish ${dirtyPushCount} changes` : "Publish"}
                </AppButton>
              )}
            </div>
          </div>

          {pushMessage && (
            <p className={`text-xs font-medium break-words ${pushState === "ok" ? "text-green-700" : "text-red-600"}`}>
              {pushMessage}
            </p>
          )}

          {/* Two-level cascading filter + missing-only checkbox */}
          <ThemeFilterBar
            sectionOptions={sectionOptions}
            showMissingOnly={showMissingOnly}
            onShowMissingOnlyChange={setShowMissingOnly}
            selectedPageCtx={selectedPageCtx}
            onPageCtxChange={setSelectedPageCtx}
          />
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className={`flex-1 overflow-y-auto ${mainPad}`} id="theme-editor-scroll">
        <div className="max-w-screen-xl mx-auto space-y-6">

          {/* Push-limit info banner */}
          {!pushBannerDismissed && (
            <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-800">
              <span className="text-base leading-none mt-0.5 shrink-0">ℹ️</span>
              <p className="text-xs leading-relaxed flex-1">
                <span className="font-semibold">Shopify allows max 250 fields per push.</span>{" "}
                Use per-section <span className="font-medium">Push section</span> buttons or the header{" "}
                <span className="font-medium">Push N changes ↑</span> button to stay within the limit.
              </p>
              <button
                onClick={() => {
                  setPushBannerDismissed(true);
                  try { sessionStorage.setItem("theme_push_banner_dismissed", "1"); } catch { /* ignore */ }
                }}
                className="shrink-0 text-amber-500 hover:text-amber-700 transition-colors p-0.5 rounded"
                title="Dismiss"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {groups.length === 0 && (
            <p className="text-sm text-gray-400 italic">No translatable theme content found. Try re-syncing.</p>
          )}

          {groups.length > 0 && visibleGroups.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <span className="text-4xl">✓</span>
              <p className="text-sm font-medium text-gray-700">
                {showMissingOnly
                  ? "All sections are fully translated!"
                  : "No sections found for the selected filter."}
              </p>
              <button
                type="button"
                onClick={() => { setShowMissingOnly(false); setSelectedPageCtx(null); }}
                className="text-xs text-indigo-600 hover:text-indigo-800 underline"
              >
                Clear filters
              </button>
            </div>
          )}

          {visibleGroups.map((pageGroup) => {
            const groupTotal = pageGroup.sections.reduce(
              (n, sec) => n + sec.blocks.reduce((m, b) => m + b.entries.length, 0),
              0
            );
            const groupDone = pageGroup.sections.reduce(
              (n, sec) =>
                n +
                sec.blocks.reduce(
                  (m, b) =>
                    m +
                    b.entries.filter(
                      (e) => !isEffectivelyEmpty(drafts[e.field.field] ?? e.field.en_content ?? "")
                    ).length,
                  0
                ),
              0
            );

            return (
            <div key={pageGroup.pageContext} id={pageContextToAnchorId(pageGroup.pageContext)}>
              {/* Page context header */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${pageBadgeColor(pageGroup.pageContext)}`}>
                  {pageGroup.label}
                </span>
                <span className="text-xs text-gray-400 font-mono">{pageGroup.pageContext !== "theme-wide" ? pageGroup.pageContext : ""}</span>
                <span className="ml-auto text-xs text-gray-400 tabular-nums shrink-0">{groupDone}/{groupTotal}</span>
              </div>

              {/* Sections */}
              <div className="space-y-3 ml-1">
                {pageGroup.sections.map((section) => {
                  const secKey = `${pageGroup.pageContext}__${section.sectionId ?? "__top__"}`;
                  const isOpen = collapsed[secKey] !== true;

                  const fieldCount = section.blocks.reduce((n, b) => n + b.entries.length, 0);
                  const doneCount = section.blocks.reduce(
                    (n, b) => n + b.entries.filter((e) => !isEffectivelyEmpty(drafts[e.field.field] ?? e.field.en_content ?? "")).length,
                    0
                  );

                  const sectionFields = section.blocks.flatMap((b) => b.entries.map((e) => e.field));
                  const sectionMissingCount = sectionFields.filter(
                    (f) => f.ru_content?.trim() && isEffectivelyEmpty(drafts[f.field] ?? f.en_content ?? "")
                  ).length;
                  const pushableCount = sectionFields.filter(
                    (f) => f.field !== "__display_title__" && !isEffectivelyEmpty(drafts[f.field] ?? f.en_content ?? "")
                  ).length;
                  const overLimit = pushableCount > 250;
                  const secPushState = sectionPush[secKey] ?? "idle";
                  const secIsTranslating = sectionTranslating.has(secKey);

                  return (
                    <div key={secKey} id={sectionAnchorId(pageGroup.pageContext, section.sectionId)} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                      {/* Section header */}
                      <div className="flex items-start gap-2 px-4 py-2.5 hover:bg-gray-50 transition-colors">
                        {/* Left: toggle zone — two lines */}
                        <button
                          type="button"
                          className="flex-1 min-w-0 text-left"
                          onClick={() => toggleSection(secKey)}
                        >
                          <div className="flex items-center gap-2">
                            <ChevronIcon open={isOpen} />
                            <span className="text-sm font-semibold text-gray-800 truncate">{section.label}</span>
                            {section.sectionId && (
                              <span
                                className="text-[10px] font-mono text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200 shrink-0"
                                title="Raw Shopify section ID"
                              >
                                {section.sectionId}
                              </span>
                            )}
                            <span className="text-sm text-gray-500 ml-1 tabular-nums shrink-0">
                              {doneCount} / {fieldCount}
                            </span>
                          </div>
                          {pageGroup.pageContext !== "theme-wide" && (
                            <p className="text-xs text-gray-400 font-mono mt-0.5 ml-5 truncate">
                              {pageGroup.pageContext}
                            </p>
                          )}
                        </button>

                        {/* Right: actions */}
                        <div className="flex items-center gap-1.5 shrink-0">

                          {/* Translate missing */}
                          {sectionMissingCount > 0 && (
                            <button
                              type="button"
                              onClick={() => void handleTranslateMissingSection(secKey, sectionFields)}
                              disabled={secIsTranslating || isTranslating}
                              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md
                                bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors
                                disabled:opacity-40 disabled:cursor-not-allowed"
                              title={`Translate ${sectionMissingCount} missing field${sectionMissingCount !== 1 ? "s" : ""}`}
                            >
                              {secIsTranslating ? <Spinner /> : <TranslateIcon />}
                              {secIsTranslating ? "…" : `Translate ${sectionMissingCount}`}
                            </button>
                          )}

                          {/* Push section */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handlePushSection(secKey, sectionFields); }}
                            disabled={secPushState === "pushing" || doneCount === 0 || overLimit}
                            className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border transition-colors
                              disabled:cursor-not-allowed
                              ${secPushState === "ok"
                                ? "bg-green-50 border-green-200 text-green-700"
                                : secPushState === "error"
                                  ? "bg-red-50 border-red-200 text-red-700"
                                  : overLimit
                                    ? "bg-amber-50 border-amber-300 text-amber-700 opacity-80"
                                    : "bg-white border-gray-200 text-gray-600 hover:bg-[#008060]/5 hover:border-[#008060]/40 hover:text-[#006e52]"
                              }`}
                            title={
                              overLimit
                                ? `Too many fields (${pushableCount}) — max 250 per push. Filter to a smaller set first.`
                                : doneCount === 0
                                  ? "No translations to push"
                                  : "Publish this section"
                            }
                          >
                            {secPushState === "pushing" ? (
                              <><Spinner /> Publishing…</>
                            ) : secPushState === "ok" ? (
                              "✓ Pushed"
                            ) : secPushState === "error" ? (
                              "✗ Error"
                            ) : overLimit ? (
                              <>Push section · <span className="tabular-nums">{pushableCount}</span> <span className="text-amber-500">⚠</span></>
                            ) : (
                              <>Push section · <span className="tabular-nums text-gray-400">{pushableCount}</span></>
                            )}
                          </button>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="border-t border-gray-100 divide-y divide-gray-50">
                          {section.blocks.map((block) => (
                            <div key={block.blockId ?? "__section__"}>
                              {/* Block sub-header (only shown when the section has more than one block or block has a real ID) */}
                              {block.blockId !== null && (
                                <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100">
                                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                                    {block.label}
                                  </span>
                                </div>
                              )}

                              <div className="space-y-3 p-3">
                              {block.entries.map(({ parsed, field }) => {
                                const draftValue = drafts[field.field] ?? field.en_content ?? "";
                                const hasContent = !isEffectivelyEmpty(draftValue);
                                const isTranslatingThis = translatingField === field.field;
                                const busy = isTranslating || isTranslatingThis;
                                const noSource = !field.ru_content?.trim();
                                const fieldLabel = humanizeSettingKey(parsed.settingKey);
                                const isFieldChanged = (drafts[field.field] ?? "") !== (originalValues.current[field.field] ?? "");
                                const isFlashing = pushFlash.has(field.field);
                                const undoDepth = undoStack.current[field.field]?.length ?? 0;

                                return (
                                  <div
                                    key={field.field}
                                    className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm transition-all duration-300"
                                    style={isFlashing
                                      ? { borderLeft: "3px solid #10B981", backgroundColor: "#f0fdf4" }
                                      : isFieldChanged
                                        ? { borderLeft: "3px solid #F59E0B", backgroundColor: "#fffbeb" }
                                        : undefined}
                                  >
                                    <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 flex-wrap">
                                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                                        {fieldLabel}
                                      </span>
                                      <FieldStatusDot status={field.status} />
                                      {field.status === "missing" && (
                                        <span className="text-xs text-amber-600 font-medium bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                                          missing
                                        </span>
                                      )}
                                      <div className="ml-auto flex items-center gap-1">
                                        {/* Per-field undo — shows when there are previous values on the stack */}
                                        {undoDepth > 0 && (
                                          <button
                                            type="button"
                                            onClick={() => handlePopUndo(field.field)}
                                            title={`Undo last change (${undoDepth} step${undoDepth !== 1 ? "s" : ""} available)`}
                                            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-gray-400 hover:text-amber-600 hover:bg-amber-50 border border-transparent hover:border-amber-200 transition-colors"
                                          >
                                            ↩ Undo
                                          </button>
                                        )}
                                        {!noSource ? (
                                          isTranslatingThis ? (
                                            <span className="flex items-center gap-1 text-xs text-indigo-500">
                                              <Spinner size="sm" /> Translating…
                                            </span>
                                          ) : hasContent ? (
                                            <button
                                              type="button"
                                              onClick={() => void handleTranslateSingleField(field, true)}
                                              disabled={busy}
                                              title="Re-translate this field (will overwrite)"
                                              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-200 transition-colors disabled:opacity-40"
                                            >
                                              <RefreshIcon size="xs" /> Re-translate
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() => void handleTranslateSingleField(field, false)}
                                              disabled={busy}
                                              title="Translate this field"
                                              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200 transition-colors disabled:opacity-40"
                                            >
                                              <TranslateIcon size="xs" /> Translate
                                            </button>
                                          )
                                        ) : null}
                                      </div>
                                    </div>

                                    {/* Source above translation on mobile, side-by-side on sm+ */}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
                                      <div className="p-4 bg-gray-50/60">
                                        <CollapsibleSource text={field.ru_content ?? ""} />
                                      </div>
                                      <div className="p-4">
                                        <textarea
                                          value={draftValue}
                                          onChange={(e) => updateDraft(field.field, e.target.value)}
                                          rows={Math.min(6, Math.max(2, Math.ceil((field.ru_content?.length ?? 0) / 60)))}
                                          className={`w-full text-sm resize-y rounded-lg border px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400
                                            ${!hasContent
                                              ? "border-amber-200 bg-amber-50/30 focus:border-amber-300"
                                              : "border-gray-200 bg-white focus:border-blue-300"
                                            }`}
                                          placeholder="Enter translation…"
                                          disabled={busy}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
