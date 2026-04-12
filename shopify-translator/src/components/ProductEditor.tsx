"use client";

import { useState } from "react";
import { Product, SyncedField } from "@/types";
import { getImageNumericId } from "@/lib/shopifySyncMapper";

interface ProductEditorProps {
  product: Product;
  productIndex: number;
  totalProducts: number;
  shopifyEnabled?: boolean;
  onSave: (updated: Product) => void;
  onTranslate: (id: string) => Promise<void>;
  onSync?: (id: string) => Promise<void>;
  onPush?: (id: string) => Promise<void>;
  onBack: () => void;
  onNavigate: (direction: "prev" | "next") => void;
}

type BodyMode = "edit" | "preview";

export default function ProductEditor({
  product,
  productIndex,
  totalProducts,
  shopifyEnabled = false,
  onSave,
  onTranslate,
  onSync,
  onPush,
  onBack,
  onNavigate,
}: ProductEditorProps) {
  const [draft, setDraft] = useState<Product>(product);
  const [bodyMode, setBodyMode] = useState<BodyMode>("edit");
  const [isDirty, setIsDirty] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPushing, setIsPushing] = useState(false);

  function update(field: keyof Product, value: string) {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
  }

  function updateSyncedField(key: string, value: string) {
    setDraft((prev) => ({
      ...prev,
      syncedFields: (prev.syncedFields ?? []).map((f) =>
        f.key === key ? { ...f, translatedValue: value } : f
      ),
    }));
    setIsDirty(true);
  }

  function handleSave() {
    const hasSyncedTranslation = (draft.syncedFields ?? []).some(
      (f) => f.translatedValue
    );
    const saved: Product = {
      ...draft,
      status:
        draft.en_title ||
        draft.en_body ||
        draft.en_meta_title ||
        draft.en_meta_description ||
        hasSyncedTranslation
          ? "translated"
          : "new",
    };
    onSave(saved);
    setIsDirty(false);
  }

  async function handleTranslate() {
    await onTranslate(product.id);
  }

  async function handleSync() {
    if (!onSync) return;
    setIsSyncing(true);
    try {
      await onSync(product.id);
    } finally {
      setIsSyncing(false);
    }
  }

  async function handlePush() {
    if (!onPush) return;
    setIsPushing(true);
    try {
      await onPush(product.id);
    } finally {
      setIsPushing(false);
    }
  }

  const isTranslating = product.isTranslating ?? false;

  // Sync draft when parent product changes after translate or sync
  const syncedFieldsDigest = JSON.stringify(
    (product.syncedFields ?? []).map((f) => f.translatedValue)
  );
  const draftSyncedFieldsDigest = JSON.stringify(
    (draft.syncedFields ?? []).map((f) => f.translatedValue)
  );
  if (
    !isDirty &&
    !isTranslating &&
    product.status === "translated" &&
    (product.en_title !== draft.en_title ||
      product.en_body !== draft.en_body ||
      product.en_meta_title !== draft.en_meta_title ||
      product.en_meta_description !== draft.en_meta_description ||
      syncedFieldsDigest !== draftSyncedFieldsDigest)
  ) {
    setDraft(product);
  }

  // Also sync draft when syncedFields arrive from a Sync operation
  const hasDraftSyncedFields = (draft.syncedFields ?? []).length > 0;
  const hasProductSyncedFields = (product.syncedFields ?? []).length > 0;
  if (
    !hasDraftSyncedFields &&
    hasProductSyncedFields
  ) {
    setDraft(product);
  }

  // Derived: group synced fields by their group label
  const syncedGroups = groupSyncedFields(draft.syncedFields ?? []);
  const imageFields = syncedGroups["Images"] ?? [];
  const hasSyncedImages = imageFields.length > 0;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* ── Editor header ── */}
      <div className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-screen-xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
          {/* Left: back + breadcrumb */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors shrink-0"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to list
            </button>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-400 font-mono truncate max-w-xs">
              {product.handle}
            </span>
            <StatusChip status={product.status} />
          </div>

          {/* Center: prev / next */}
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <button
              onClick={() => onNavigate("prev")}
              disabled={productIndex === 0}
              className="p-1.5 rounded-md hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Previous product"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="tabular-nums">{productIndex + 1} / {totalProducts}</span>
            <button
              onClick={() => onNavigate("next")}
              disabled={productIndex === totalProducts - 1}
              className="p-1.5 rounded-md hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Next product"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {isDirty && (
              <span className="text-xs text-amber-600 font-medium bg-amber-50 border border-amber-200 px-2 py-1 rounded-md">
                Unsaved changes
              </span>
            )}

            {/* Sync from Shopify */}
            {shopifyEnabled && onSync && (
              <button
                onClick={handleSync}
                disabled={isSyncing || isTranslating}
                title="Fetch translatable fields (inc. image alts) from Shopify"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-all
                  ${isSyncing || isTranslating
                    ? "bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed"
                    : "bg-white border-violet-300 text-violet-600 hover:bg-violet-50"
                  }`}
              >
                {isSyncing ? (
                  <><Spinner /> Syncing…</>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Sync
                  </>
                )}
              </button>
            )}

            {/* Translate */}
            <button
              onClick={handleTranslate}
              disabled={isTranslating}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
                ${isTranslating
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm"
                }`}
            >
              {isTranslating ? (
                <><Spinner /> Translating…</>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                  </svg>
                  {product.status === "translated" ? "Re-translate" : "Translate"}
                </>
              )}
            </button>

            {/* Save */}
            <button
              onClick={handleSave}
              disabled={!isDirty}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
                ${!isDirty
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
                }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Save
            </button>

            {/* Push to Shopify */}
            {shopifyEnabled && onPush && product.shopifyId && (
              <button
                onClick={handlePush}
                disabled={isPushing || isTranslating || !product.syncedFields?.some((f) => f.translatedValue)}
                title="Push translations to Shopify via translationsRegister"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-all
                  ${isPushing || isTranslating || !product.syncedFields?.some((f) => f.translatedValue)
                    ? "bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed"
                    : "bg-white border-emerald-400 text-emerald-700 hover:bg-emerald-50"
                  }`}
              >
                {isPushing ? (
                  <><Spinner /> Pushing…</>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    Push
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Editor body ── */}
      <div className="flex-1 max-w-screen-xl mx-auto w-full px-6 py-6">
        <div className="grid grid-cols-2 gap-6 items-start">

          {/* ── LEFT: Russian source ── */}
          <div className="space-y-6">
            <SectionHeader label="Russian" accent="red" description="Source content — read only" />

            <FieldGroup label="Title">
              <ReadonlyText>{product.ru_title || <EmptyPlaceholder />}</ReadonlyText>
            </FieldGroup>

            <FieldGroup label="Body (HTML)">
              <HtmlDisplay html={product.ru_body} />
            </FieldGroup>

            {(product.ru_meta_title || product.ru_meta_description) && (
              <GroupSection label="SEO / Meta">
                {product.ru_meta_title && (
                  <FieldGroup label="Meta Title">
                    <ReadonlyText>{product.ru_meta_title}</ReadonlyText>
                  </FieldGroup>
                )}
                {product.ru_meta_description && (
                  <FieldGroup label="Meta Description">
                    <ReadonlyText className="whitespace-pre-wrap">
                      {product.ru_meta_description}
                    </ReadonlyText>
                  </FieldGroup>
                )}
              </GroupSection>
            )}

            {/* Images — source side */}
            {hasSyncedImages && (
              <GroupSection label="Images">
                {imageFields.map((f) => (
                  <ImageAltRow
                    key={f.key}
                    field={f}
                    imageUrl={getImageUrl(f.key, product.imageUrlMap)}
                    side="source"
                  />
                ))}
              </GroupSection>
            )}

            {/* Sync prompt when Shopify is available but not yet synced */}
            {shopifyEnabled && !hasSyncedImages && (
              <div className="border border-dashed border-violet-200 rounded-xl p-4 bg-violet-50 text-sm text-violet-600 space-y-1">
                <p className="font-medium">Image alt texts not loaded</p>
                <p className="text-xs text-violet-500">
                  Click <strong>Sync</strong> to fetch image alt fields from Shopify.
                </p>
              </div>
            )}
          </div>

          {/* ── RIGHT: English editable ── */}
          <div className="space-y-6">
            <SectionHeader label="English" accent="blue" description="Translation — editable" />

            <FieldGroup label="Title">
              <input
                type="text"
                value={draft.en_title}
                onChange={(e) => update("en_title", e.target.value)}
                placeholder={isTranslating ? "Translating…" : "Enter English title…"}
                disabled={isTranslating}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 transition-shadow"
              />
            </FieldGroup>

            <FieldGroup
              label="Body (HTML)"
              right={
                <ToggleButton
                  value={bodyMode}
                  options={[
                    { id: "edit", label: "Edit" },
                    { id: "preview", label: "Preview" },
                  ]}
                  onChange={(v) => setBodyMode(v as BodyMode)}
                />
              }
            >
              {bodyMode === "edit" ? (
                <textarea
                  value={draft.en_body}
                  onChange={(e) => update("en_body", e.target.value)}
                  placeholder={isTranslating ? "Translating…" : "Enter English body HTML…"}
                  disabled={isTranslating}
                  rows={14}
                  spellCheck={false}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 resize-y transition-shadow leading-relaxed"
                />
              ) : (
                <HtmlDisplay html={draft.en_body} minHeight="14rem" />
              )}
            </FieldGroup>

            <GroupSection label="SEO / Meta">
              <FieldGroup
                label="Meta Title"
                hint={draft.en_meta_title ? `${draft.en_meta_title.length} chars` : undefined}
                hintColor={draft.en_meta_title.length > 60 ? "red" : "gray"}
              >
                <input
                  type="text"
                  value={draft.en_meta_title}
                  onChange={(e) => update("en_meta_title", e.target.value)}
                  placeholder={isTranslating ? "Translating…" : "Enter SEO title…"}
                  disabled={isTranslating}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 transition-shadow"
                />
              </FieldGroup>

              <FieldGroup
                label="Meta Description"
                hint={
                  draft.en_meta_description
                    ? `${draft.en_meta_description.length} chars`
                    : undefined
                }
                hintColor={draft.en_meta_description.length > 160 ? "red" : "gray"}
              >
                <textarea
                  value={draft.en_meta_description}
                  onChange={(e) => update("en_meta_description", e.target.value)}
                  placeholder={isTranslating ? "Translating…" : "Enter SEO description…"}
                  disabled={isTranslating}
                  rows={4}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 resize-y transition-shadow"
                />
              </FieldGroup>
            </GroupSection>

            {/* Images — editable side */}
            {hasSyncedImages && (
              <GroupSection label="Images">
                {imageFields.map((f) => (
                  <ImageAltRow
                    key={f.key}
                    field={f}
                    imageUrl={getImageUrl(f.key, draft.imageUrlMap)}
                    side="edit"
                    isTranslating={isTranslating}
                    onChange={(val) => updateSyncedField(f.key, val)}
                  />
                ))}
              </GroupSection>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function groupSyncedFields(fields: SyncedField[]): Record<string, SyncedField[]> {
  const groups: Record<string, SyncedField[]> = {};
  for (const f of fields) {
    if (!groups[f.group]) groups[f.group] = [];
    groups[f.group].push(f);
  }
  return groups;
}

function getImageUrl(
  key: string,
  imageUrlMap?: Record<string, string>
): string | undefined {
  if (!imageUrlMap) return undefined;
  const numericId = getImageNumericId(key);
  return numericId ? imageUrlMap[numericId] : undefined;
}

// ── Sub-components ────────────────────────────────────────────────────────

function GroupSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-gray-200 pt-5 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      {children}
    </div>
  );
}

function ImageAltRow({
  field,
  imageUrl,
  side,
  isTranslating = false,
  onChange,
}: {
  field: SyncedField;
  imageUrl?: string;
  side: "source" | "edit";
  isTranslating?: boolean;
  onChange?: (val: string) => void;
}) {
  const value = side === "source" ? field.sourceValue : field.translatedValue;
  return (
    <div className="flex gap-3 items-start">
      {/* Thumbnail or placeholder */}
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="w-12 h-12 object-cover rounded-md border border-gray-200 shrink-0 bg-gray-100"
        />
      ) : (
        <div className="w-12 h-12 rounded-md border border-dashed border-gray-200 shrink-0 bg-gray-50 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-400 mb-1">{field.label}</p>
        {side === "source" ? (
          <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 min-h-[2.25rem] leading-snug">
            {value || <EmptyPlaceholder />}
          </div>
        ) : (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={isTranslating ? "Translating…" : "Enter English alt text…"}
            disabled={isTranslating}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 transition-shadow"
          />
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  label,
  accent,
  description,
}: {
  label: string;
  accent: "red" | "blue";
  description: string;
}) {
  const colors = {
    red: "text-red-500 border-red-200 bg-red-50",
    blue: "text-blue-600 border-blue-200 bg-blue-50",
  };
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${colors[accent]}`}>
      <span className="text-sm font-bold">{label}</span>
      <span className="text-xs opacity-70">{description}</span>
    </div>
  );
}

function FieldGroup({
  label,
  hint,
  hintColor = "gray",
  right,
  children,
}: {
  label: string;
  hint?: string;
  hintColor?: "gray" | "red";
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {label}
        </label>
        <div className="flex items-center gap-2">
          {hint && (
            <span
              className={`text-xs tabular-nums ${
                hintColor === "red" ? "text-red-500 font-semibold" : "text-gray-400"
              }`}
            >
              {hint}
            </span>
          )}
          {right}
        </div>
      </div>
      {children}
    </div>
  );
}

function ReadonlyText({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 min-h-[2.5rem] leading-snug ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function HtmlDisplay({ html, minHeight }: { html: string; minHeight?: string }) {
  if (!html) {
    return (
      <div
        className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm"
        style={{ minHeight: minHeight ?? "6rem" }}
      >
        <EmptyPlaceholder />
      </div>
    );
  }
  return (
    <div
      className="px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg overflow-y-auto prose prose-sm max-w-none text-gray-800"
      style={{ minHeight: minHeight ?? "6rem", maxHeight: "28rem" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ToggleButton({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className={`px-2.5 py-1 font-medium transition-colors ${
            value === opt.id
              ? "bg-gray-800 text-white"
              : "bg-white text-gray-500 hover:bg-gray-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StatusChip({ status }: { status: Product["status"] }) {
  if (status === "translated") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        Translated
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
      Untranslated
    </span>
  );
}

function EmptyPlaceholder() {
  return <span className="text-gray-300 italic text-xs">No content</span>;
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
