"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { TranslationRecord } from "@/types";
import { loadSettings } from "@/lib/settingsStorage";
import { readActiveLocale } from "@/lib/activeLocaleStorage";
import { translateFields } from "@/utils/openai";
import { isEffectivelyEmpty } from "@/utils/isEffectivelyEmpty";
import {
  AppButton,
  BackButton,
  TypeChip,
  MissingBadge,
  Spinner as UiSpinner,
  TranslateIcon,
  RefreshIcon,
  ChevronIcon,
} from "@/components/ui";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MenuEditorProps {
  record: TranslationRecord;
  linkRecords: TranslationRecord[];
  onSave: (r: TranslationRecord) => void;
  onBack: () => void;
  onPushedToShopify?: (id: string) => void;
}

interface SectionItem {
  record: TranslationRecord;
  depth: number;
}

interface Section {
  id: string;
  label: string;
  items: SectionItem[];
}

type PushStatus = "idle" | "pushing" | "ok" | "error";

// ── Tree builder ──────────────────────────────────────────────────────────────

interface TreeNode {
  record: TranslationRecord;
  children: TreeNode[];
}

function buildTree(links: TranslationRecord[]): TreeNode[] {
  const topLevel = links
    .filter((r) => !r.parentLinkId || r.menuItemDepth === 0)
    .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));

  function childNodes(parentId: string): TreeNode[] {
    return links
      .filter((r) => r.parentLinkId === parentId)
      .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
      .map((r) => ({ record: r, children: childNodes(r.identification) }));
  }

  const idSet = new Set(links.map((r) => r.identification));
  return topLevel
    .filter((r) => idSet.has(r.identification))
    .map((r) => ({ record: r, children: childNodes(r.identification) }));
}

function flattenNode(node: TreeNode, depth: number): SectionItem[] {
  const items: SectionItem[] = [{ record: node.record, depth }];
  for (const child of node.children) items.push(...flattenNode(child, depth + 1));
  return items;
}

// ── Dropdown ──────────────────────────────────────────────────────────────────

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

// ── Filter bar ────────────────────────────────────────────────────────────────

function MenuFilterBar({
  sections,
  showMissingOnly,
  onShowMissingOnlyChange,
  selectedSectionId,
  onSectionSelect,
  onJumpToSection,
}: {
  sections: Section[];
  showMissingOnly: boolean;
  onShowMissingOnlyChange: (v: boolean) => void;
  selectedSectionId: string | null;
  onSectionSelect: (id: string | null) => void;
  onJumpToSection: (id: string) => void;
}) {
  const btnBase =
    "flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs text-gray-700 hover:border-gray-300 hover:bg-gray-50 transition-colors shadow-sm";
  const selected = sections.find((s) => s.id === selectedSectionId);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <SimpleDropdown
        trigger={
          <div className={`${btnBase} cursor-pointer`}>
            <span className="truncate max-w-[160px]">
              {selected ? selected.label : "All sections"}
            </span>
            {selectedSectionId && (
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSectionSelect(null);
                }}
                className="ml-1 text-gray-400 hover:text-gray-600 cursor-pointer leading-none"
                aria-label="Clear section filter"
              >
                ×
              </span>
            )}
            <svg
              className="w-3 h-3 text-gray-400 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        }
      >
        <div className="py-1">
          <button
            type="button"
            className="w-full text-left px-4 py-2 text-xs hover:bg-gray-50 text-gray-700 font-medium"
            onClick={() => onSectionSelect(null)}
          >
            All sections
          </button>
          <div className="my-1 border-t border-gray-100" />
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className="w-full text-left px-4 py-2 text-xs hover:bg-blue-50 hover:text-blue-700 text-gray-600 flex items-center justify-between gap-2"
              onClick={() => {
                onSectionSelect(s.id);
                onJumpToSection(s.id);
              }}
            >
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </div>
      </SimpleDropdown>

      <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showMissingOnly}
          onChange={(e) => onShowMissingOnlyChange(e.target.checked)}
          className="rounded accent-[#008060]"
        />
        Missing only
      </label>
    </div>
  );
}

// ── Item row — exact ThemeEditor card layout ──────────────────────────────────

function ItemRow({
  record,
  depth,
  draft,
  isDirty,
  prevDraft,
  isTranslating,
  onDraftChange,
  onTranslateItem,
  onUndoDraft,
}: {
  record: TranslationRecord;
  depth: number;
  draft: string;
  isDirty: boolean;
  prevDraft: string | null;
  isTranslating: boolean;
  onDraftChange: (id: string, value: string) => void;
  onTranslateItem: (r: TranslationRecord) => void;
  onUndoDraft: (id: string) => void;
}) {
  const source = record.fields.find((f) => f.field === "title")?.ru_content ?? record.handle ?? "";
  const isEmpty = isEffectivelyEmpty(draft);
  const hasUndo = prevDraft !== null && prevDraft !== draft;

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm transition-all duration-300"
      style={
        isDirty
          ? { borderLeft: "3px solid #F59E0B", backgroundColor: "#fffbeb" }
          : undefined
      }
    >
      {/* Field header — label + actions */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
          {"  ".repeat(depth)}Title
        </span>
        {isEmpty && (
          <span className="text-xs text-amber-600 font-medium bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
            missing
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hasUndo && (
            <button
              type="button"
              onClick={() => onUndoDraft(record.id)}
              title="Undo last AI translation"
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-gray-400 hover:text-amber-600 hover:bg-amber-50 border border-transparent hover:border-amber-200 transition-colors"
            >
              ↩ Undo
            </button>
          )}
          {isTranslating ? (
            <span className="flex items-center gap-1 text-xs text-indigo-500">
              <UiSpinner className="w-3 h-3" /> Translating…
            </span>
          ) : isEmpty ? (
            <button
              type="button"
              onClick={() => onTranslateItem(record)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200 transition-colors"
            >
              <TranslateIcon size="xs" /> Translate
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onTranslateItem(record)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-200 transition-colors"
            >
              <RefreshIcon size="xs" /> Re-translate
            </button>
          )}
        </div>
      </div>

      {/* Source | Translation — 2-col grid */}
      <div className="grid grid-cols-2 divide-x divide-gray-100">
        <div className="p-4 bg-gray-50/60">
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed break-words">
            {source || <span className="text-gray-300 italic">empty</span>}
          </p>
        </div>
        <div className="p-4">
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(record.id, e.target.value)}
            rows={Math.max(2, Math.ceil((source.length) / 60))}
            className={`w-full text-sm resize-y rounded-lg border px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 ${
              !isEmpty
                ? "border-gray-200 bg-white focus:border-blue-300"
                : "border-amber-200 bg-amber-50/30 focus:border-amber-300"
            }`}
            placeholder="Enter translation…"
          />
        </div>
      </div>
    </div>
  );
}

// ── Section card — exact ThemeEditor section style ────────────────────────────

function SectionCard({
  section,
  isMenuTitleSection,
  drafts,
  dirtyIds,
  prevDrafts,
  translatingId,
  sectionTranslating,
  pushStatus,
  isOpen,
  showMissingOnly,
  onToggle,
  onDraftChange,
  onTranslateItem,
  onUndoDraft,
  onPushSection,
  onTranslateSection,
}: {
  section: Section;
  isMenuTitleSection: boolean;
  drafts: Record<string, string>;
  dirtyIds: Set<string>;
  prevDrafts: Record<string, string | null>;
  translatingId: string | null;
  sectionTranslating: boolean;
  pushStatus: PushStatus;
  isOpen: boolean;
  showMissingOnly: boolean;
  onToggle: () => void;
  onDraftChange: (id: string, value: string) => void;
  onTranslateItem: (r: TranslationRecord) => void;
  onUndoDraft: (id: string) => void;
  onPushSection: (s: Section) => void;
  onTranslateSection: (s: Section) => void;
}) {
  const visibleItems = showMissingOnly
    ? section.items.filter((item) => isEffectivelyEmpty(drafts[item.record.id] ?? ""))
    : section.items;

  const doneCount = section.items.filter(
    (item) => !isEffectivelyEmpty(drafts[item.record.id] ?? ""),
  ).length;
  const missingCount = section.items.length - doneCount;

  return (
    <div
      id={`menu-section-${section.id}`}
      className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
    >
      {/* Section header — same as ThemeEditor */}
      <div className="flex items-start gap-2 px-4 py-2.5 hover:bg-gray-50 transition-colors">
        <button
          type="button"
          className="flex-1 min-w-0 text-left flex items-center gap-2"
          onClick={onToggle}
        >
          <ChevronIcon open={isOpen} />
          <span className="text-sm font-semibold text-gray-800 truncate">
            {isMenuTitleSection ? "Menu title" : section.label}
          </span>
          <span className="text-sm text-gray-500 ml-1 tabular-nums shrink-0">
            {doneCount} / {section.items.length}
          </span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {missingCount > 0 && (
            <button
              type="button"
              onClick={() => onTranslateSection(section)}
              disabled={sectionTranslating || translatingId !== null}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md
                bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors
                disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sectionTranslating ? <UiSpinner className="w-3 h-3" /> : <TranslateIcon size="xs" />}
              {sectionTranslating ? "…" : `Translate ${missingCount}`}
            </button>
          )}

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPushSection(section); }}
            disabled={pushStatus === "pushing" || doneCount === 0}
            className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border transition-colors
              disabled:cursor-not-allowed
              ${pushStatus === "ok"
                ? "bg-green-50 border-green-200 text-green-700"
                : pushStatus === "error"
                ? "bg-red-50 border-red-200 text-red-700"
                : doneCount === 0
                ? "bg-gray-50 border-gray-200 text-gray-400 opacity-60"
                : "bg-white border-gray-200 text-gray-600 hover:bg-[#008060]/5 hover:border-[#008060]/40 hover:text-[#006e52]"
              }`}
          >
            {pushStatus === "pushing" ? (
              <><UiSpinner className="w-3 h-3" /> Publishing…</>
            ) : pushStatus === "ok" ? (
              "✓ Pushed"
            ) : pushStatus === "error" ? (
              "✗ Error"
            ) : (
              <>Push section · <span className="tabular-nums text-gray-400">{doneCount}</span></>
            )}
          </button>
        </div>
      </div>

      {/* Items */}
      {isOpen && (
        <div className="border-t border-gray-100 space-y-3 p-3">
          {visibleItems.length > 0 ? (
            visibleItems.map(({ record, depth }) => (
              <ItemRow
                key={record.id}
                record={record}
                depth={depth}
                draft={drafts[record.id] ?? ""}
                isDirty={dirtyIds.has(record.id)}
                prevDraft={prevDrafts[record.id] ?? null}
                isTranslating={translatingId === record.id}
                onDraftChange={onDraftChange}
                onTranslateItem={onTranslateItem}
                onUndoDraft={onUndoDraft}
              />
            ))
          ) : (
            <p className="py-4 text-center text-sm text-gray-400">
              {showMissingOnly ? "All items translated in this section." : "No items in this section."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MenuEditor({
  record,
  linkRecords,
  onSave,
  onBack,
  onPushedToShopify,
}: MenuEditorProps) {
  // ── Initial drafts ─────────────────────────────────────────────────────────

  const initialDrafts = useMemo(() => {
    const d: Record<string, string> = {};
    const menuTitle = record.fields.find((f) => f.field === "title");
    if (menuTitle) d[record.id] = menuTitle.en_content ?? "";
    for (const r of linkRecords) {
      const f = r.fields.find((x) => x.field === "title");
      if (f) d[r.id] = f.en_content ?? "";
    }
    return d;
  }, [record, linkRecords]);

  // ── State ──────────────────────────────────────────────────────────────────

  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const savedRef = useRef<Record<string, string>>(initialDrafts);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  // prevDrafts: stores pre-translate value for per-field undo (mirrors ThemeEditor undo stack)
  const [prevDrafts, setPrevDrafts] = useState<Record<string, string | null>>({});

  const [translatingId, setTranslatingId] = useState<string | null>(null);
  const [translatingAll, setTranslatingAll] = useState(false);
  const [sectionTranslatingIds, setSectionTranslatingIds] = useState<Set<string>>(new Set());
  const [pushState, setPushState] = useState<PushStatus>("idle");
  const [pushMessage, setPushMessage] = useState("");
  const [sectionPush, setSectionPush] = useState<Record<string, PushStatus>>({});

  // All open by default (empty collapsed set)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const [showMissingOnly, setShowMissingOnly] = useState(false);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);

  // ── Derived ────────────────────────────────────────────────────────────────

  const tree = useMemo(() => buildTree(linkRecords), [linkRecords]);
  const allRecords = useMemo(() => [record, ...linkRecords], [record, linkRecords]);

  const sections = useMemo<Section[]>(() => {
    const menuLabel =
      record.fields.find((f) => f.field === "title")?.ru_content ?? record.handle ?? "Menu title";
    const result: Section[] = [
      {
        id: "__menu_title__",
        label: menuLabel,
        items: [{ record, depth: 0 }],
      },
    ];
    for (const node of tree) {
      const label =
        node.record.fields.find((f) => f.field === "title")?.ru_content ??
        node.record.handle ??
        node.record.id;
      result.push({ id: node.record.id, label, items: flattenNode(node, 0) });
    }
    return result;
  }, [record, tree]);

  const { totalDone, totalCount, missingCount } = useMemo(() => {
    let done = 0;
    for (const r of allRecords) {
      if (!isEffectivelyEmpty(drafts[r.id] ?? "")) done++;
    }
    return { totalDone: done, totalCount: allRecords.length, missingCount: allRecords.length - done };
  }, [allRecords, drafts]);

  const isDirty = dirtyIds.size > 0;

  const visibleSections = useMemo(() => {
    let result = sections;
    if (selectedSectionId !== null) result = result.filter((s) => s.id === selectedSectionId);
    if (showMissingOnly)
      result = result.filter((s) =>
        s.items.some((item) => isEffectivelyEmpty(drafts[item.record.id] ?? "")),
      );
    return result;
  }, [sections, selectedSectionId, showMissingOnly, drafts]);

  const menuLabel =
    record.fields.find((f) => f.field === "title")?.ru_content ?? record.handle ?? "";
  const noLinkData = linkRecords.length === 0;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function applyDraft(id: string, value: string) {
    setDrafts((prev) => ({ ...prev, [id]: value }));
    setDirtyIds((prev) => {
      const next = new Set(prev);
      if (value !== (savedRef.current[id] ?? "")) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function applyTranslation(id: string, value: string, currentDraft: string) {
    // Store pre-translate value so the ↩ Undo button can restore it
    setPrevDrafts((prev) => ({ ...prev, [id]: currentDraft }));
    applyDraft(id, value);
  }

  function handleUndoDraft(id: string) {
    const prev = prevDrafts[id];
    if (prev === null || prev === undefined) return;
    applyDraft(id, prev);
    setPrevDrafts((p) => ({ ...p, [id]: null }));
  }

  function toggleSection(id: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function jumpToSection(id: string) {
    const el = document.getElementById(`menu-section-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }


  function commitRecord(r: TranslationRecord, enValue: string) {
    const updatedFields = r.fields.map((f) =>
      f.field === "title"
        ? {
            ...f,
            en_content: enValue,
            status: enValue.trim() ? ("done" as const) : ("missing" as const),
          }
        : f,
    );
    onSave({ ...r, fields: updatedFields });
  }

  function handleSave() {
    for (const id of dirtyIds) {
      const r = allRecords.find((x) => x.id === id);
      if (r) commitRecord(r, drafts[id] ?? "");
    }
    savedRef.current = { ...drafts };
    setDirtyIds(new Set());
  }

  // ── Translate one ──────────────────────────────────────────────────────────

  const handleTranslateItem = useCallback(
    async (r: TranslationRecord) => {
      const ruText = r.fields.find((f) => f.field === "title")?.ru_content ?? "";
      if (!ruText.trim()) return;
      setTranslatingId(r.id);
      try {
        const settings = loadSettings();
        const results = await translateFields(
          [{ key: "title", text: ruText, fieldType: "plain" }],
          { ...settings, targetLanguage: readActiveLocale(settings.shopifyDomain) },
        );
        const translation = results[0]?.translation ?? "";
        if (translation) applyTranslation(r.id, translation, drafts[r.id] ?? "");
      } catch (e) {
        console.error("[MenuEditor] translate failed:", e);
      } finally {
        setTranslatingId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts],
  );

  // ── Translate all missing ──────────────────────────────────────────────────

  async function handleTranslateAll() {
    setTranslatingAll(true);
    const settings = loadSettings();
    const translateSettings = { ...settings, targetLanguage: readActiveLocale(settings.shopifyDomain) };
    const untranslated = allRecords.filter((r) => isEffectivelyEmpty(drafts[r.id] ?? ""));
    for (const r of untranslated) {
      const ruText = r.fields.find((f) => f.field === "title")?.ru_content ?? "";
      if (!ruText.trim()) continue;
      setTranslatingId(r.id);
      try {
        const results = await translateFields(
          [{ key: "title", text: ruText, fieldType: "plain" }],
          translateSettings,
        );
        const translation = results[0]?.translation ?? "";
        if (translation) applyTranslation(r.id, translation, drafts[r.id] ?? "");
      } catch {
        // continue with next
      }
    }
    setTranslatingId(null);
    setTranslatingAll(false);
  }

  // ── Translate section missing ──────────────────────────────────────────────

  async function handleTranslateSection(section: Section) {
    setSectionTranslatingIds((prev) => new Set(prev).add(section.id));
    const settings = loadSettings();
    const translateSettings = { ...settings, targetLanguage: readActiveLocale(settings.shopifyDomain) };
    const missing = section.items.filter(({ record: r }) => isEffectivelyEmpty(drafts[r.id] ?? ""));
    for (const { record: r } of missing) {
      const ruText = r.fields.find((f) => f.field === "title")?.ru_content ?? "";
      if (!ruText.trim()) continue;
      setTranslatingId(r.id);
      try {
        const results = await translateFields(
          [{ key: "title", text: ruText, fieldType: "plain" }],
          translateSettings,
        );
        const translation = results[0]?.translation ?? "";
        if (translation) applyTranslation(r.id, translation, drafts[r.id] ?? "");
      } catch {
        // continue
      }
    }
    setTranslatingId(null);
    setSectionTranslatingIds((prev) => { const next = new Set(prev); next.delete(section.id); return next; });
  }

  // ── Push section ───────────────────────────────────────────────────────────

  async function handlePushSection(section: Section) {
    setSectionPush((prev) => ({ ...prev, [section.id]: "pushing" }));
    const settings = loadSettings();
    let errors = 0;
    const toPush = section.items.filter(
      ({ record: r }) => !isEffectivelyEmpty(drafts[r.id] ?? ""),
    );
    for (const { record: r } of toPush) {
      try {
        const res = await fetch("/api/shopify/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shopifyDomain: settings.shopifyDomain,
            resourceId: r.identification,
            resourceType: r.type,
            locale: r.locale,
            fields: [{ key: "title", value: drafts[r.id]! }],
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          errors++;
        } else {
          commitRecord(r, drafts[r.id]!);
          onPushedToShopify?.(r.id);
        }
      } catch {
        errors++;
      }
    }
    const state: PushStatus = errors === 0 ? "ok" : "error";
    setSectionPush((prev) => ({ ...prev, [section.id]: state }));
    setTimeout(() => setSectionPush((prev) => ({ ...prev, [section.id]: "idle" })), 4000);
  }

  // ── Push all ───────────────────────────────────────────────────────────────

  async function handlePushAll() {
    setPushState("pushing");
    setPushMessage("");
    const settings = loadSettings();
    const toPush = allRecords.filter((r) => !isEffectivelyEmpty(drafts[r.id] ?? ""));
    if (toPush.length === 0) {
      setPushMessage("Nothing to push — translate items first.");
      setPushState("error");
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 4000);
      return;
    }
    let errors = 0;
    for (const r of toPush) {
      try {
        const res = await fetch("/api/shopify/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shopifyDomain: settings.shopifyDomain,
            resourceId: r.identification,
            resourceType: r.type,
            locale: r.locale,
            fields: [{ key: "title", value: drafts[r.id]! }],
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) errors++;
        else {
          commitRecord(r, drafts[r.id]!);
          onPushedToShopify?.(r.id);
        }
      } catch {
        errors++;
      }
    }
    if (errors === 0) {
      setPushState("ok");
      setPushMessage(`Pushed ${toPush.length} item${toPush.length !== 1 ? "s" : ""}`);
      setDirtyIds(new Set()); // clear dirty state so Undo is hidden after publish
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 5000);
    } else {
      setPushMessage(`${errors} item${errors !== 1 ? "s" : ""} failed to push.`);
      setPushState("error");
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 6000);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">

      {/* ── Sticky header ── */}
      <div className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10 shrink-0">
        <div className="max-w-screen-xl mx-auto px-6 py-3 flex flex-col gap-2">

          {/* ── Row 1: Navigation ── */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <BackButton onClick={onBack} />
            <span className="text-gray-200">|</span>
            <TypeChip label="Menu" colorClass="bg-teal-100 text-teal-800 border-teal-200/80" />
            <span className="text-sm text-gray-700 font-medium truncate" title={menuLabel}>
              {menuLabel}
            </span>
            <MissingBadge count={missingCount} />
          </div>

          {/* ── Row 2: Actions ── */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              {/* Translate: primary blue when action needed, ghost when fully done */}
              <AppButton
                variant={missingCount > 0 ? "blue" : "translate"}
                onClick={() => void handleTranslateAll()}
                disabled={translatingAll || translatingId !== null}
                loading={translatingAll}
                loadingText="Translating…"
              >
                {missingCount === 0
                  ? "Re-translate"
                  : totalDone === 0
                    ? "Translate"
                    : "Translate missing"}
              </AppButton>

              <AppButton variant="secondary" onClick={handleSave} disabled={!isDirty}>
                Save
              </AppButton>

              {/* Publish: primary green when fully translated, secondary when translation still needed */}
              <AppButton
                variant={missingCount > 0 ? "secondary" : "primary"}
                onClick={() => void handlePushAll()}
                loading={pushState === "pushing"}
                loadingText="Publishing…"
                className={
                  pushState === "ok"
                    ? "!bg-green-500 !border-green-500 !text-white"
                    : pushState === "error"
                    ? "!bg-red-500 !border-red-500 !text-white"
                    : ""
                }
              >
                {pushState === "ok"
                  ? `✓ ${pushMessage || "Published"}`
                  : "Publish"}
              </AppButton>
            </div>
          </div>

          {pushMessage && pushState === "error" && (
            <p className="text-xs font-medium text-red-600 break-words">{pushMessage}</p>
          )}

          {/* Filter bar */}
          {!noLinkData && (
            <MenuFilterBar
              sections={sections}
              showMissingOnly={showMissingOnly}
              onShowMissingOnlyChange={setShowMissingOnly}
              selectedSectionId={selectedSectionId}
              onSectionSelect={setSelectedSectionId}
              onJumpToSection={jumpToSection}
            />
          )}
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-screen-xl mx-auto space-y-4">

          {noLinkData ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-400">
              Re-sync Menus to load menu items. Items appear here after a fresh sync.
            </div>
          ) : visibleSections.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-400">
              No sections match the current filter.
            </div>
          ) : (
            visibleSections.map((section, idx) => (
              <SectionCard
                key={section.id}
                section={section}
                isMenuTitleSection={idx === 0 && section.id === "__menu_title__"}
                drafts={drafts}
                dirtyIds={dirtyIds}
                prevDrafts={prevDrafts}
                translatingId={translatingId}
                sectionTranslating={sectionTranslatingIds.has(section.id)}
                pushStatus={sectionPush[section.id] ?? "idle"}
                isOpen={!collapsedSections.has(section.id)}
                showMissingOnly={showMissingOnly}
                onToggle={() => toggleSection(section.id)}
                onDraftChange={applyDraft}
                onTranslateItem={(r) => void handleTranslateItem(r)}
                onUndoDraft={handleUndoDraft}
                onPushSection={(s) => void handlePushSection(s)}
                onTranslateSection={(s) => void handleTranslateSection(s)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
