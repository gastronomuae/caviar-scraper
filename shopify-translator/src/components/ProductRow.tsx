"use client";

import { memo, useState, type KeyboardEvent } from "react";
import { TranslationRecord } from "@/types";
import { SOURCE_LOCALE } from "@/lib/storeConfig";
import { canPushTranslationRecord } from "@/utils/pushEligibility";
import HighlightText from "./HighlightText";
import { type FieldMatch } from "./ProductTable";

interface ProductRowProps {
  record: TranslationRecord;
  index: number;
  searchQuery: string;
  /** Non-null when the search matched a non-title field; shows a snippet chip. */
  matchSnippet?: FieldMatch;
  onOpenEditor: (id: string) => void;
  onTranslate: (id: string) => void;
  onPushRow: (id: string) => void | Promise<void>;
  pushingRowId: string | null;
  isPushingBulk: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  pushedToShopify: boolean;
  activeRowId?: string | null;
  onInlineFieldChange: (recordId: string, fieldKey: string, value: string) => void;
  onInlineSaveRow: (recordId: string) => void;
  onInlineTranslateRow: (recordId: string) => void;
  /** For MENU type rows: number of LINK (menu-item) child records. */
  menuItemCount?: number;
  /**
   * For PRODUCT_OPTION / PRODUCT_OPTION_VALUE deduped rows: how many Shopify
   * resource records share the same source text (digest). Shows "×N products" badge.
   */
  sharedCount?: number;
}

const PUSH_STATUS_STYLES = {
  pushed: "bg-green-50 text-green-700",
  notPushed: "bg-amber-50 text-amber-700",
} as const;

const STATUS_STYLES: Record<TranslationRecord["status"], string> = {
  translated: "bg-green-50 text-green-700",
  outdated: "bg-orange-50 text-orange-700",
  partial: "bg-blue-50 text-blue-600",
  new: "bg-amber-50 text-amber-700",
};

const STATUS_DOT: Record<TranslationRecord["status"], string> = {
  translated: "bg-green-400",
  outdated: "bg-orange-400",
  partial: "bg-blue-400",
  new: "bg-amber-400",
};

const STATUS_LABELS: Record<TranslationRecord["status"], string> = {
  translated: "Translated",
  outdated: "Outdated",
  partial: "Partial",
  new: "Untranslated",
};

/** Admin resource status + publishedAt fallback; CSV rows have neither → no badge. */
function listingResourceStatus(record: TranslationRecord): "active" | "draft" | null {
  const rs = record.shopifyResourceStatus;
  if (rs === "ACTIVE") return "active";
  if (rs === "DRAFT") return "draft";
  if (rs === "ARCHIVED") return null;
  if (record.shopifyPublishedAt !== undefined) {
    return record.shopifyPublishedAt != null && record.shopifyPublishedAt !== "" ? "active" : "draft";
  }
  return null;
}

function ProductRow({
  record,
  index,
  searchQuery,
  matchSnippet,
  onOpenEditor,
  onTranslate,
  onPushRow,
  pushingRowId,
  isPushingBulk,
  selected,
  onToggleSelect,
  pushedToShopify,
  activeRowId,
  onInlineFieldChange: _onInlineFieldChange,
  onInlineSaveRow: _onInlineSaveRow,
  onInlineTranslateRow: _onInlineTranslateRow,
  menuItemCount,
  sharedCount,
}: ProductRowProps) {
  const isTranslating = record.isTranslating ?? false;
  const isPushingThisRow = pushingRowId === record.id;
  const pushDisabled = isPushingBulk || pushingRowId !== null;

  const showTranslate = record.status !== "translated" && !isTranslating;
  const showPush = !pushedToShopify && canPushTranslationRecord(record);

  const titleField = record.fields.find(
    (f) => f.field === "title" || f.field === "name" || f.field === "__display_title__"
  );
  const metafieldDisplayField =
    record.type === "METAFIELD"
      ? record.fields.find((f) => f.displayName?.trim() || f.namespaceKey?.trim()) ??
        record.fields.find((f) => f.field.startsWith("meta."))
      : undefined;
  const ruT = (titleField?.ru_content ?? "").trim();
  const enT = (titleField?.en_content ?? "").trim();
  const metafieldDisplayName =
    (metafieldDisplayField?.displayName ?? "").trim() ||
    (metafieldDisplayField?.namespaceKey ?? "").trim() ||
    (metafieldDisplayField?.field ?? "").replace(/^meta\./, "").trim();
  const metafieldParentTitle = (metafieldDisplayField?.parentTitle ?? "").trim();
  const metafieldParentType = (metafieldDisplayField?.parentType ?? "").trim();
  const metafieldValue = (metafieldDisplayField?.en_content ?? "").trim() || (metafieldDisplayField?.ru_content ?? "").trim();
  const listTitle =
    record.type === "METAFIELD" && metafieldDisplayName
      ? `${metafieldDisplayName} | ${metafieldValue || "—"}`
      : (ruT || enT);

  const fallbackTooltip = record.used_fallback
    ? `Expected ${SOURCE_LOCALE}, found ${record.resolved_source_locale ?? "(unknown)"}`
    : undefined;

  const isActive = activeRowId === record.id;
  const resourceStatus = listingResourceStatus(record);
  const [isOpening, setIsOpening] = useState(false);

  function openRowEditor() {
    setIsOpening(true);
    onOpenEditor(record.id);
  }

  function handleRowKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openRowEditor();
    }
  }

  return (
    <div
      role="row"
      tabIndex={0}
      aria-label={listTitle ? `Open ${listTitle}` : `Open product ${record.handle}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-checkbox]")) return;
        openRowEditor();
      }}
      onKeyDown={handleRowKeyDown}
      className={`group flex items-center gap-2 sm:gap-2.5 border rounded-lg px-2.5 py-2 sm:px-3 sm:py-2 cursor-pointer transition-all ${
        isOpening ? "opacity-60" : ""
      } ${
        selected
          ? "border-blue-500 ring-2 ring-blue-100 bg-blue-50/50 hover:bg-blue-50/70"
          : isActive
            ? "border-indigo-400 ring-1 ring-indigo-100 bg-indigo-50/30 hover:bg-indigo-50/50"
            : record.used_fallback
              ? "border-amber-300/90 bg-amber-50/30 hover:border-amber-400 hover:bg-amber-50/50"
              : "border-gray-200 bg-white hover:bg-gray-50/90 hover:border-blue-300 hover:shadow-sm"
      }`}
    >
      <div
        data-checkbox=""
        className="flex items-center justify-center shrink-0 w-10 h-10 -ml-1.5 -my-1"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(record.id);
        }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => e.stopPropagation()}
          className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 pointer-events-none"
          aria-label={`Select ${record.handle}`}
        />
      </div>
      <span className="text-[10px] text-gray-300 font-mono w-5 sm:w-6 shrink-0 text-right select-none tabular-nums pt-0.5">
        {index + 1}
      </span>
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          isTranslating ? "bg-blue-400 animate-pulse" : STATUS_DOT[record.status]
        }`}
      />

      <div className="flex-1 min-w-0 py-0.5">
        <div className="flex items-center min-w-0 w-full flex-nowrap gap-1.5 sm:gap-2">
          <p className="text-sm font-bold text-gray-900 min-w-0 flex-1 truncate leading-snug">
            {listTitle ? (
              <HighlightText text={listTitle} query={searchQuery} />
            ) : (
              <span className="text-gray-400 font-normal italic">No title</span>
            )}
          </p>
          {menuItemCount !== undefined && (
            <span className="shrink-0 text-[11px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 leading-none tabular-nums">
              {menuItemCount} item{menuItemCount !== 1 ? "s" : ""}
            </span>
          )}
          {sharedCount !== undefined && sharedCount > 0 && (
            <span
              className="shrink-0 text-[11px] font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5 leading-none tabular-nums"
              title={`This value is shared across ${sharedCount.toLocaleString()} ${sharedCount === 1 ? "product" : "products"} — translating it updates all of them`}
            >
              ×{sharedCount.toLocaleString()} {sharedCount === 1 ? "product" : "products"}
            </span>
          )}
        </div>
        <HighlightText
          text={
            record.type === "METAFIELD" && (metafieldParentTitle || metafieldParentType)
              ? `${metafieldParentType || "RESOURCE"} › ${metafieldParentTitle || record.handle}`
              : record.handle
          }
          query={searchQuery}
          className="text-sm text-gray-500 truncate block max-w-full mt-0.5"
        />
        {resourceStatus && (
          <p className="mt-0.5 text-sm text-gray-600">
            <span className={resourceStatus === "active" ? "text-green-500" : "text-gray-400"}>●</span>{" "}
            {resourceStatus === "active" ? "Active" : "Draft"}
          </p>
        )}
        {(record.type === "PRODUCT_OPTION" || record.type === "PRODUCT_OPTION_VALUE") && !sharedCount && (
          <p className="mt-0.5 text-[11px] text-amber-700 leading-snug">
            ⚠ Shared across products — editing affects all products using this value
          </p>
        )}
        {matchSnippet && (
          <p className="mt-1 text-[10px] text-gray-500 leading-snug flex items-start gap-1.5 min-w-0">
            <span className="shrink-0 text-gray-400">Match in</span>
            <span className="inline-flex items-center gap-1 px-1 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700 font-medium shrink-0">
              {matchSnippet.fieldLabel}
              <span className="text-amber-400">·</span>
              {matchSnippet.side === "ru" ? "RU" : "EN"}
            </span>
            <span className="truncate min-w-0">
              <HighlightText text={matchSnippet.snippet} query={searchQuery} />
            </span>
          </p>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-2 sm:gap-2.5">
        <div className="flex flex-col items-end gap-0.5 justify-center max-w-[9rem]">
          {record.reviewed && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-slate-100 text-slate-600 border border-slate-200"
              title="Marked reviewed"
            >
              Reviewed
            </span>
          )}
          {record.used_fallback && (
            <span
              title={fallbackTooltip}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-100 text-amber-900 border border-amber-300/80 cursor-help"
            >
              ⚠ Source
            </span>
          )}
          {!isTranslating && pushedToShopify && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium ${PUSH_STATUS_STYLES.pushed}`}
            >
              Pushed
            </span>
          )}
          {isTranslating ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-blue-50 text-blue-600">
              <Spinner /> …
            </span>
          ) : (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium ${STATUS_STYLES[record.status]}`}
            >
              {STATUS_LABELS[record.status]}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEditor(record.id);
          }}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded-md border border-indigo-200 bg-indigo-50/80 hover:bg-indigo-100 transition-colors"
        >
          Edit
        </button>
        {(showPush || showTranslate) && (
          <div className="hidden sm:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {showPush && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void onPushRow(record.id);
                }}
                disabled={pushDisabled}
                title="Publish"
                className={`shrink-0 p-1.5 rounded-md border transition-all flex items-center justify-center
                  ${
                    pushDisabled
                      ? "border-transparent text-gray-300 cursor-not-allowed"
                      : "border-[#008060]/30 text-[#008060] hover:bg-[#008060]/10 hover:border-[#008060]"
                  }`}
              >
                {isPushingThisRow ? (
                  <RowSpinner className="text-[#008060]" />
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M15.337 23.979l6.31-1.364S18.585 6.936 18.567 6.81c-.018-.124-.124-.207-.236-.207-.111 0-2.044-.042-2.044-.042s-1.352-1.322-1.488-1.458v18.876zM12.18 5.223s-.871-.253-1.928-.253c-1.993 0-2.953 1.254-2.953 2.34 0 1.285.994 1.908 1.928 2.49.941.59 1.274.998 1.274 1.544 0 .618-.499 1.127-1.326 1.127-1.201 0-1.928-.498-1.928-.498l-.346 1.592s.727.58 2.085.58c2.152 0 3.365-1.148 3.365-2.655 0-1.4-1.052-2.04-1.994-2.607-.831-.502-1.207-.854-1.207-1.385 0-.452.415-.949 1.279-.949.914 0 1.637.312 1.637.312l.114-1.637zM10.879.576C10.879.576 9.9.866 9.9.866 9.9.866 9.9.853 9.9.84c0-1.144-.768-1.758-1.7-1.758-.118 0-.236.012-.354.036L7.588 0s-.08.312-.08.312L7.588 0c-.756.257-1.5.894-2.055 2.204-.42.988-.707 2.226-.789 3.185H3.5L3.18 7.052h1.238C4.064 9.22 3.93 11.52 3.93 11.52L7.22 12.5s.062-2.477.364-4.707a52.68 52.68 0 00.097-.741h1.28l.32-1.663h-1.26c.063-.742.213-1.413.424-1.879.32-.707.773-1.058 1.14-1.12.28-.048.539.015.701.165l.594-2.979zM17.49 5.52s-1.3-.055-1.74-.055c-.346 0-1.284.055-1.284.055L11.1 23.979h4.74L17.49 5.52z" />
                  </svg>
                )}
              </button>
            )}
            {showTranslate && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTranslate(record.id);
                }}
                disabled={isTranslating}
                title="Translate this record"
                className={`shrink-0 p-1.5 rounded-md border transition-all
                  ${
                    isTranslating
                      ? "border-transparent text-gray-300 cursor-not-allowed"
                      : "border-gray-200 text-gray-400 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50"
                  }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
        <svg
          className="w-4 h-4 text-gray-300 group-hover:text-gray-500 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        </div>
      </div>
    </div>
  );
}

export default memo(ProductRow);

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function RowSpinner({ className }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 animate-spin ${className ?? ""}`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
