"use client";

import { useState, useEffect, useRef } from "react";
import { TranslationRecord, TranslationField, FieldType, TranslateRunResult } from "@/types";
import { canPushTranslationRecord } from "@/utils/pushEligibility";
import RichTextEditor from "./RichTextEditor";
import { translateFields } from "@/utils/openai";
import { loadSettings, saveSettings } from "@/lib/settingsStorage";
import { readActiveLocale } from "@/lib/activeLocaleStorage";
import { SOURCE_LOCALE } from "@/lib/storeConfig";
import { isEffectivelyEmpty } from "@/utils/isEffectivelyEmpty";
import { AppButton, BackButton, MissingBadge, Spinner as UiSpinner } from "@/components/ui";

interface ProductEditorProps {
  record: TranslationRecord;
  recordIndex: number;
  totalRecords: number;
  onSave: (updated: TranslationRecord) => void;
  onTranslate: (id: string, skipExisting?: boolean) => Promise<TranslateRunResult>;
  /** Called after a successful push to Shopify (session list shows “Pushed”) */
  onPushedToShopify?: (recordId: string) => void;
  onBack: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  /** Full-page vs side panel (split with list) */
  layout?: "page" | "panel";
  /** Child METAFIELD records that belong to this product (parentType=PRODUCT, same handle). */
  metafieldRecords?: TranslationRecord[];
  /** Called whenever a metafield record's draft is auto-saved. */
  onSaveMetafield?: (updated: TranslationRecord) => void;
  /** METAOBJECT records (e.g. FAQ entries) referenced by this product. */
  faqRecords?: TranslationRecord[];
  /** Called whenever a FAQ record's draft is auto-saved. */
  onSaveFaq?: (updated: TranslationRecord) => void;
}

export default function ProductEditor({
  record,
  recordIndex,
  totalRecords,
  onSave,
  onTranslate,
  onPushedToShopify,
  onBack,
  onNavigate,
  layout = "page",
  metafieldRecords = [],
  onSaveMetafield,
  faqRecords = [],
  onSaveFaq,
}: ProductEditorProps) {
  const [draftFields, setDraftFields] = useState<TranslationField[]>(record.fields);
  const [isDirty, setIsDirty] = useState(false);
  const [translatingField, setTranslatingField] = useState<string | null>(null);
  const [pushState, setPushState] = useState<"idle" | "pushing" | "ok" | "error">("idle");
  const [pushMessage, setPushMessage] = useState("");
  /**
   * True when a backup exists for this record (set after a successful push;
   * cleared after a successful restore). Session-only — no server round-trip on mount.
   */
  const recordRef = useRef(record);
  recordRef.current = record;


  // ── Metafield draft state ─────────────────────────────────────────────────
  // Map of recordId → { fieldKey → en_content }
  const [metafieldDrafts, setMetafieldDrafts] = useState<Record<string, Record<string, string>>>(
    () => buildMetafieldDraftMap(metafieldRecords)
  );
  const [metafieldsDirty, setMetafieldsDirty] = useState(false);
  const prevMfTranslatingRef = useRef<Record<string, boolean>>({});

  // ── FAQ draft state ───────────────────────────────────────────────────────
  const [faqDrafts, setFaqDrafts] = useState<Record<string, Record<string, string>>>(
    () => buildMetafieldDraftMap(faqRecords)
  );
  const [faqDirty, setFaqDirty] = useState(false);
  const prevFaqTranslatingRef = useRef<Record<string, boolean>>({});

  // Sync after translation completes
  useEffect(() => {
    if (!record.isTranslating && !isDirty) {
      setDraftFields(record.fields);
    }
    if (!record.isTranslating && isDirty) {
      // Merge only freshly translated fields (fields that were previously empty)
      setDraftFields((prev) =>
        prev.map((f) => {
          const updated = record.fields.find((rf) => rf.field === f.field);
          if (!updated) return f;
          // Auto-update only if the draft has no real visible content
          // (treats "<p></p>" from TipTap initialisation as empty)
          if (isEffectivelyEmpty(f.en_content) && updated.en_content) {
            return { ...f, en_content: updated.en_content, status: updated.status };
          }
          return f;
        })
      );
    }
  }, [record.isTranslating]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a metafield record finishes translating externally, pull new translations into drafts
  // (only for fields that were empty in the draft — don't overwrite user edits).
  useEffect(() => {
    const prev = prevMfTranslatingRef.current;
    const next: Record<string, boolean> = {};
    for (const mf of metafieldRecords) next[mf.id] = mf.isTranslating ?? false;
    prevMfTranslatingRef.current = next;

    const justFinished = metafieldRecords.filter(
      (mf) => prev[mf.id] === true && !mf.isTranslating
    );
    if (!justFinished.length) return;

    setMetafieldDrafts((prevDrafts) => {
      let changed = false;
      const updated = { ...prevDrafts };
      for (const mf of justFinished) {
        const existingDraft = prevDrafts[mf.id] ?? {};
        const newDraft: Record<string, string> = { ...existingDraft };
        for (const f of mf.fields) {
          if (isEffectivelyEmpty(existingDraft[f.field] ?? "")) {
            newDraft[f.field] = f.en_content ?? "";
            changed = true;
          }
        }
        updated[mf.id] = newDraft;
      }
      return changed ? updated : prevDrafts;
    });
  }); // intentionally runs every render; ref tracks previous state

  // Auto-save dirty metafield drafts back to the parent records store
  useEffect(() => {
    if (!metafieldsDirty || !onSaveMetafield || !metafieldRecords.length) return;
    const t = window.setTimeout(() => {
      for (const mf of metafieldRecords) {
        const draft = metafieldDrafts[mf.id];
        if (!draft) continue;
        const updatedFields = mf.fields.map((f) => ({
          ...f,
          en_content: draft[f.field] ?? f.en_content ?? "",
          status: (isEffectivelyEmpty(draft[f.field] ?? "") ? "missing" : "done") as "missing" | "done",
        }));
        onSaveMetafield({ ...mf, fields: updatedFields });
      }
      setMetafieldsDirty(false);
    }, 900);
    return () => clearTimeout(t);
  }, [metafieldDrafts, metafieldsDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateMetafieldField(recordId: string, fieldKey: string, value: string) {
    setMetafieldDrafts((prev) => ({
      ...prev,
      [recordId]: { ...(prev[recordId] ?? {}), [fieldKey]: value },
    }));
    setMetafieldsDirty(true);
  }

  // Sync FAQ translations into drafts when a FAQ record finishes translating
  useEffect(() => {
    const prev = prevFaqTranslatingRef.current;
    const next: Record<string, boolean> = {};
    for (const faq of faqRecords) next[faq.id] = faq.isTranslating ?? false;
    prevFaqTranslatingRef.current = next;
    const justFinished = faqRecords.filter((faq) => prev[faq.id] === true && !faq.isTranslating);
    if (!justFinished.length) return;
    setFaqDrafts((prevDrafts) => {
      let changed = false;
      const updated = { ...prevDrafts };
      for (const faq of justFinished) {
        const existingDraft = prevDrafts[faq.id] ?? {};
        const newDraft: Record<string, string> = { ...existingDraft };
        for (const f of faq.fields) {
          if (isEffectivelyEmpty(existingDraft[f.field] ?? "")) {
            newDraft[f.field] = f.en_content ?? "";
            changed = true;
          }
        }
        updated[faq.id] = newDraft;
      }
      return changed ? updated : prevDrafts;
    });
  }); // intentionally runs every render; ref tracks previous state

  // Auto-save dirty FAQ drafts back to parent store
  useEffect(() => {
    if (!faqDirty || !onSaveFaq || !faqRecords.length) return;
    const t = window.setTimeout(() => {
      for (const faq of faqRecords) {
        const draft = faqDrafts[faq.id];
        if (!draft) continue;
        const updatedFields = faq.fields.map((f) => ({
          ...f,
          en_content: draft[f.field] ?? f.en_content ?? "",
          status: (isEffectivelyEmpty(draft[f.field] ?? "") ? "missing" : "done") as "missing" | "done",
        }));
        onSaveFaq({ ...faq, fields: updatedFields });
      }
      setFaqDirty(false);
    }, 900);
    return () => clearTimeout(t);
  }, [faqDrafts, faqDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateFaqField(recordId: string, fieldKey: string, value: string) {
    setFaqDrafts((prev) => ({
      ...prev,
      [recordId]: { ...(prev[recordId] ?? {}), [fieldKey]: value },
    }));
    setFaqDirty(true);
  }

  function updateField(field: string, value: string) {
    setDraftFields((prev) =>
      prev.map((f) =>
        f.field === field
          ? { ...f, en_content: value, status: isEffectivelyEmpty(value) ? "missing" : "done" }
          : f
      )
    );
    setIsDirty(true);
  }

  function handleSave() {
    onSave({ ...record, fields: draftFields });
    setIsDirty(false);
  }

  // Debounced autosave while editing
  useEffect(() => {
    if (!isDirty) return;
    const t = window.setTimeout(() => {
      onSave({ ...recordRef.current, fields: draftFields });
      setIsDirty(false);
    }, 900);
    return () => clearTimeout(t);
  }, [draftFields, isDirty, onSave]);

  // Ctrl+Enter → translate page (including metafields)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        void handleTranslateAll(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [record.id, onTranslate, metafieldRecords, metafieldDrafts]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePush() {
    if (!canPushTranslationRecord(record)) {
      setPushState("error");
      setPushMessage("Translate this item before pushing to Shopify.");
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 5000);
      return;
    }
    const settings = loadSettings();
    if (!settings.shopifyDomain?.trim()) {
      setPushState("error");
      setPushMessage("Not connected to Shopify. Go to Settings and set your store domain (OAuth or custom app).");
      setTimeout(() => setPushState("idle"), 6000);
      return;
    }

    // Auto-save first so we push the latest draft
    if (isDirty) {
      onSave({ ...record, fields: draftFields });
      setIsDirty(false);
    }

    const fieldsToSend = draftFields
      .filter((f) => f.field !== "__display_title__" && f.en_content && !isEffectivelyEmpty(f.en_content))
      .map((f) => ({ key: f.field, value: f.en_content }));

    if (fieldsToSend.length === 0) {
      setPushState("error");
      setPushMessage("Nothing to push — translate the product first.");
      setTimeout(() => setPushState("idle"), 4000);
      return;
    }

    // Flush metafield drafts to parent store before pushing
    if (metafieldsDirty && onSaveMetafield) {
      for (const mf of metafieldRecords) {
        const draft = metafieldDrafts[mf.id];
        if (!draft) continue;
        const updatedFields = mf.fields.map((f) => ({
          ...f,
          en_content: draft[f.field] ?? f.en_content ?? "",
          status: (isEffectivelyEmpty(draft[f.field] ?? "") ? "missing" : "done") as "missing" | "done",
        }));
        onSaveMetafield({ ...mf, fields: updatedFields });
      }
      setMetafieldsDirty(false);
    }

    // Flush FAQ drafts to parent store before pushing
    if (faqDirty && onSaveFaq) {
      for (const faq of faqRecords) {
        const draft = faqDrafts[faq.id];
        if (!draft) continue;
        const updatedFields = faq.fields.map((f) => ({
          ...f,
          en_content: draft[f.field] ?? f.en_content ?? "",
          status: (isEffectivelyEmpty(draft[f.field] ?? "") ? "missing" : "done") as "missing" | "done",
        }));
        onSaveFaq({ ...faq, fields: updatedFields });
      }
      setFaqDirty(false);
    }

    setPushState("pushing");
    setPushMessage("");
    try {
      let totalPushed = 0;

      // Push main product record
      const res = await fetch("/api/shopify/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopifyDomain: settings.shopifyDomain,
          shopifyClientId: settings.shopifyClientId,
          shopifyClientSecret: settings.shopifyClientSecret,
          resourceId: record.identification,
          resourceType: record.type,
          locale: record.locale,
          fields: fieldsToSend,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      totalPushed += data.pushed ?? 0;
      onPushedToShopify?.(record.id);

      // Push each metafield record that has translated content
      if (metafieldRecords.length) {
        await Promise.all(
          metafieldRecords.map(async (mf) => {
            const draft = metafieldDrafts[mf.id];
            const mfFields = mf.fields
              .map((f) => ({ key: f.field, value: draft?.[f.field] ?? f.en_content ?? "" }))
              .filter((f) => !isEffectivelyEmpty(f.value));
            console.log(`[push/mf-client] id=${mf.id} type=${mf.type} identification=${mf.identification} fields=${mfFields.map((f) => f.key).join(",") || "(none)"}`);
            if (!mfFields.length) return;
            try {
              const mfRes = await fetch("/api/shopify/push", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  shopifyDomain: settings.shopifyDomain,
                  resourceId: mf.identification,
                  resourceType: mf.type,
                  locale: mf.locale,
                  fields: mfFields,
                }),
              });
              const mfData = await mfRes.json().catch(() => ({})) as { error?: string; pushed?: number };
              if (mfRes.ok) {
                totalPushed += mfData.pushed ?? 0;
                onPushedToShopify?.(mf.id);
              } else {
                console.error(`[push/mf-client] failed for ${mf.identification} (${mf.type}): ${mfData.error ?? `HTTP ${mfRes.status}`}`);
              }
            } catch (e) {
              console.error(`[push/mf-client] exception for ${mf.identification}:`, e);
            }
          })
        );
      }

      // Push each FAQ metaobject record that has translated content
      if (faqRecords.length) {
        const faqPushErrors: string[] = [];
        await Promise.all(
          faqRecords.map(async (faq) => {
            const draft = faqDrafts[faq.id];
            // Prefer draft value (user-edited this session), fall back to stored en_content
            const faqFields = faq.fields
              .map((f) => ({ key: f.field, value: draft?.[f.field] ?? f.en_content ?? "" }))
              .filter((f) => !isEffectivelyEmpty(f.value));
            console.log(`[push/faq-client] id=${faq.id} type=${faq.type} identification=${faq.identification} fields=${faqFields.map((f) => f.key).join(",") || "(none)"} hasDraft=${!!draft}`);
            if (!faqFields.length) {
              console.warn(`[push/faq-client] skipping ${faq.identification} — no translated content (draft=${JSON.stringify(draft)}, en_content=${faq.fields.map((f) => f.en_content).join("|")})`);
              return;
            }
            try {
              const faqRes = await fetch("/api/shopify/push", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  shopifyDomain: settings.shopifyDomain,
                  resourceId: faq.identification,
                  resourceType: faq.type,
                  locale: faq.locale,
                  fields: faqFields,
                }),
              });
              const faqData = await faqRes.json().catch(() => ({})) as { error?: string; pushed?: number };
              if (faqRes.ok) {
                totalPushed += faqData.pushed ?? 0;
                onPushedToShopify?.(faq.id);
              } else {
                const errMsg = faqData.error ?? `HTTP ${faqRes.status}`;
                console.error(`[push/faq-client] failed for ${faq.identification} (${faq.type}): ${errMsg}`);
                faqPushErrors.push(errMsg);
              }
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : "unknown error";
              console.error(`[push/faq-client] exception for ${faq.identification}:`, e);
              faqPushErrors.push(errMsg);
            }
          })
        );
        if (faqPushErrors.length) {
          console.error(`[push/faq-client] ${faqPushErrors.length} FAQ push(es) failed:`, faqPushErrors);
        }
      }

      setPushState("ok");
      setPushMessage(`Pushed ${totalPushed} field${totalPushed !== 1 ? "s" : ""} to Shopify`);
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 5000);
    } catch (e) {
      setPushState("error");
      setPushMessage(e instanceof Error ? e.message : "Push failed");
      setTimeout(() => { setPushState("idle"); setPushMessage(""); }, 8000);
    }
  }


  // Translate a single field inline without triggering the full-record translate
  async function onTranslateSingleField(
    fieldKey: string,
    ruContent: string,
    fieldType: FieldType,
    force: boolean
  ) {
    const current = draftFields.find((f) => f.field === fieldKey);
    // skip only if content exists AND it's cleanly done (not outdated)
    if (!force && current?.en_content?.trim() && current?.status === "done") return;

    setTranslatingField(fieldKey);
    try {
      const settings = loadSettings();
      const results = await translateFields([{ key: fieldKey, text: ruContent, fieldType }], {
        ...settings,
        targetLanguage: readActiveLocale(settings.shopifyDomain),
      });
      const translation = results[0]?.translation;
      if (translation) {
        updateField(fieldKey, translation);
      }
    } catch (e) {
      console.error("Single field translation failed:", e);
    } finally {
      setTranslatingField(null);
    }
  }

  const isTranslating = record.isTranslating ?? false;
  const isAnyMfTranslating = metafieldRecords.some((mf) => mf.isTranslating);
  const isAnyFaqTranslating = faqRecords.some((faq) => faq.isTranslating);

  // For Products and Collections: hide fields where source has no content.
  const visibleFields = (
    record.type === "PRODUCT" || record.type === "COLLECTION"
      ? draftFields.filter((f) => f.ru_content?.trim())
      : draftFields
  ).filter((f) => f.field !== "__display_title__");

  // Count outdated / missing in this record
  const outdatedCount = visibleFields.filter((f) => f.csvStatus === "outdated").length;
  const missingCount = visibleFields.filter((f) => f.status === "missing").length;

  // Include metafield missing count in header badge and translate banner
  const metafieldMissingCount = metafieldRecords.reduce((sum, mf) => {
    const draft = metafieldDrafts[mf.id] ?? {};
    return (
      sum +
      mf.fields.filter(
        (f) => f.ru_content?.trim() && isEffectivelyEmpty(draft[f.field] ?? f.en_content ?? "")
      ).length
    );
  }, 0);

  const faqMissingCount = faqRecords.reduce((sum, faq) => {
    const draft = faqDrafts[faq.id] ?? {};
    return (
      sum +
      faq.fields.filter(
        (f) => f.ru_content?.trim() && isEffectivelyEmpty(draft[f.field] ?? f.en_content ?? "")
      ).length
    );
  }, 0);

  const totalMissingCount = missingCount + metafieldMissingCount + faqMissingCount;

  // Show push button if main record OR any metafield/FAQ has translated content
  const hasMetafieldContent = metafieldRecords.some((mf) =>
    mf.fields.some((f) => !isEffectivelyEmpty(metafieldDrafts[mf.id]?.[f.field] ?? f.en_content ?? ""))
  );
  const hasFaqContent = faqRecords.some((faq) =>
    faq.fields.some((f) => !isEffectivelyEmpty(faqDrafts[faq.id]?.[f.field] ?? f.en_content ?? ""))
  );
  const showPushButton = canPushTranslationRecord(record) || hasMetafieldContent || hasFaqContent;

  // Translate all — main record + metafields + FAQ entries missing translation
  async function handleTranslateAll(skipExisting: boolean) {
    void onTranslate(record.id, skipExisting);
    for (const mf of metafieldRecords) {
      const draft = metafieldDrafts[mf.id] ?? {};
      const hasMissing = mf.fields.some(
        (f) => f.ru_content?.trim() && isEffectivelyEmpty(draft[f.field] ?? f.en_content ?? "")
      );
      if (!skipExisting || hasMissing) void onTranslate(mf.id, skipExisting);
    }
    for (const faq of faqRecords) {
      const draft = faqDrafts[faq.id] ?? {};
      const hasMissing = faq.fields.some(
        (f) => f.ru_content?.trim() && isEffectivelyEmpty(draft[f.field] ?? f.en_content ?? "")
      );
      if (!skipExisting || hasMissing) void onTranslate(faq.id, skipExisting);
    }
  }
  const storefrontBase = "https://www.gastronom.ae";
  const ruOpenUrl = `${storefrontBase}/products/${record.handle}`;
  const enOpenUrl = `${storefrontBase}/en/products/${record.handle}`;
  const shelfStatus = resolveShelfStatus(record);

  const shellClass =
    layout === "panel"
      ? "min-h-0 h-full flex flex-col bg-slate-50 overflow-hidden"
      : "h-screen flex flex-col bg-slate-50 overflow-hidden";
  const headerPad = layout === "panel" ? "px-4 py-2.5" : "px-6 py-3";
  const mainPad = layout === "panel" ? "px-4 py-4" : "px-6 py-6";

  return (
    <div className={shellClass}>
      {/* ── Sticky header ── */}
      <div className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10 shrink-0">
        <div className={`max-w-screen-xl mx-auto ${headerPad} flex flex-col gap-2`}>
          {/* ── Row 1: Navigation ── */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <BackButton onClick={onBack} />
            <span className="text-gray-200">|</span>
            <TypeBadge type={record.type} />
            <StatusBadge status={record.status} />
            {shelfStatus && (
              <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                {shelfStatus}
              </span>
            )}
            {record.used_fallback && (
              <span
                title={`Expected ${SOURCE_LOCALE}, found ${record.resolved_source_locale ?? "(unknown)"}`}
                className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-300/80 cursor-help shrink-0"
              >
                ⚠ Source mismatch
              </span>
            )}
            {outdatedCount > 0 && (
              <span className="text-xs text-orange-600 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full font-medium">
                {outdatedCount} outdated
              </span>
            )}
            <MissingBadge count={totalMissingCount} />
          </div>

          {/* ── Row 2: Actions ── */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              {/* Translate: primary blue when action needed, ghost when fully done */}
              <AppButton
                variant={totalMissingCount > 0 ? "blue" : "translate"}
                onClick={() => handleTranslateAll(totalMissingCount > 0)}
                title={
                  totalMissingCount === 0
                    ? "Re-translate all fields on this page"
                    : record.translation_status === "missing"
                      ? "Translate all fields on this page"
                      : "Translate missing fields on this page"
                }
                loading={isTranslating || isAnyMfTranslating}
                loadingText="Translating…"
              >
                {totalMissingCount === 0
                  ? "Re-translate"
                  : record.translation_status === "missing"
                    ? "Translate"
                    : "Translate missing"}
              </AppButton>

              <AppButton
                variant="secondary"
                onClick={handleSave}
                disabled={!isDirty}
              >
                Save
              </AppButton>

              {/* Publish: primary green when fully translated, secondary when translation still needed */}
              {showPushButton && (
                <AppButton
                  variant={totalMissingCount > 0 ? "secondary" : "primary"}
                  onClick={handlePush}
                  loading={pushState === "pushing"}
                  loadingText="Publishing…"
                  title="Publish translated content directly to Shopify (no CSV needed)"
                  className={
                    pushState === "ok"    ? "!bg-green-600 !border-green-600 !text-white" :
                    pushState === "error" ? "!bg-red-500 !border-red-500 !text-white" : ""
                  }
                >
                  {pushState === "ok" ? (
                    pushMessage
                  ) : pushState === "error" ? (
                    <span className="text-xs leading-tight max-w-[200px] truncate">{pushMessage || "Error"}</span>
                  ) : (
                    "Publish"
                  )}
                </AppButton>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Push error — full message below header if too long */}
      {pushState === "error" && pushMessage.length > 40 && (
        <div className="bg-red-50 border-b border-red-200 px-4 sm:px-6 py-2.5 text-sm text-red-700 flex items-start gap-2 break-words">
          <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="break-words min-w-0">{pushMessage}</span>
        </div>
      )}

      {/* ── Editor body ── */}
      <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain max-w-screen-xl mx-auto w-full ${mainPad} space-y-5`}>
        {/* Column labels */}
        <div className="grid grid-cols-2 gap-6">
          <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg">
            <span className="text-sm font-bold text-gray-700">Source</span>
            <a
              href={ruOpenUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-1 text-xs font-mono text-gray-500 hover:text-gray-800 underline-offset-2 hover:underline truncate"
              title={ruOpenUrl}
            >
              {ruOpenUrl}
            </a>
          </div>
          <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg">
            <span className="text-sm font-bold text-blue-600">Translation</span>
            <a
              href={enOpenUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block mt-1 text-xs font-mono text-blue-500 hover:text-blue-700 underline-offset-2 hover:underline truncate"
              title={enOpenUrl}
            >
              {enOpenUrl}
            </a>
          </div>
        </div>

        {/* Fields — grouped into Core / SEO / Product Organization / Metafields */}
        {visibleFields.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p>No translatable content found for this record.</p>
          </div>
        ) : (
          <GroupedFields
            fields={visibleFields}
            draftFields={draftFields}
            isTranslating={isTranslating}
            recordType={record.type}
            updateField={updateField}
            onTranslateSingleField={onTranslateSingleField}
          />
        )}

        {/* ── Metafields section — child METAFIELD records embedded here ── */}
        {metafieldRecords.length > 0 && (
          <MetafieldSection
            metafieldRecords={metafieldRecords}
            metafieldDrafts={metafieldDrafts}
            isTranslating={isTranslating}
            onUpdate={updateMetafieldField}
            onTranslateRecord={(id) => void onTranslate(id, true)}
          />
        )}

        {/* ── Linked metaobjects — referenced METAOBJECT entries shown inline ── */}
        {faqRecords.length > 0 && (
          <LinkedMetaobjectsSection
            faqRecords={faqRecords}
            faqDrafts={faqDrafts}
            isTranslating={isTranslating || isAnyFaqTranslating}
            onUpdate={updateFaqField}
            onTranslateRecord={(id) => void onTranslate(id, true)}
          />
        )}
      </div>
    </div>
  );
}

// ── Metafield draft helper ──────────────────────────────────────────────────

function buildMetafieldDraftMap(
  records: TranslationRecord[]
): Record<string, Record<string, string>> {
  const map: Record<string, Record<string, string>> = {};
  for (const mf of records) {
    map[mf.id] = {};
    for (const f of mf.fields) {
      map[mf.id][f.field] = f.en_content ?? "";
    }
  }
  return map;
}

// ── Metafield section ───────────────────────────────────────────────────────

function MetafieldSection({
  metafieldRecords,
  metafieldDrafts,
  isTranslating,
  onUpdate,
  onTranslateRecord,
}: {
  metafieldRecords: TranslationRecord[];
  metafieldDrafts: Record<string, Record<string, string>>;
  isTranslating: boolean;
  onUpdate: (recordId: string, fieldKey: string, value: string) => void;
  onTranslateRecord: (recordId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const visibleRecords = metafieldRecords.filter((mf) =>
    mf.fields.some((f) => f.ru_content?.trim())
  );
  if (!visibleRecords.length) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-teal-600 hover:text-teal-700 transition-colors"
        >
          <svg
            className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Metafields
          <span className="text-teal-400 font-normal normal-case tracking-normal">
            ({visibleRecords.length})
          </span>
        </button>
        <div className="flex-1 border-t border-teal-200" />
      </div>

      {open &&
        visibleRecords.map((mf) => {
          const draft = metafieldDrafts[mf.id] ?? {};
          return mf.fields
            .filter((f) => f.ru_content?.trim())
            .map((field) => (
              <MetafieldFieldBlock
                key={`${mf.id}:${field.field}`}
                field={field}
                draftValue={draft[field.field] ?? ""}
                isTranslating={isTranslating || (mf.isTranslating ?? false)}
                onChange={(val) => onUpdate(mf.id, field.field, val)}
                onTranslate={() => onTranslateRecord(mf.id)}
              />
            ));
        })}
    </div>
  );
}

function MetafieldFieldBlock({
  field,
  draftValue,
  isTranslating,
  onChange,
  onTranslate,
}: {
  field: TranslationField;
  draftValue: string;
  isTranslating: boolean;
  onChange: (val: string) => void;
  onTranslate: () => void;
}) {
  const label = field.displayName?.trim() || field.namespaceKey || field.field;
  const hasTranslation = !isEffectivelyEmpty(draftValue);

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</span>
        {field.namespaceKey && (
          <span className="text-[10px] text-gray-400 font-mono">{field.namespaceKey}</span>
        )}
        <FieldStatusDot status={field.status} />
        <div className="ml-auto">
          {isTranslating ? (
            <span className="flex items-center gap-1 text-xs text-indigo-500">
              <Spinner size="sm" /> Translating…
            </span>
          ) : !hasTranslation ? (
            <button
              onClick={onTranslate}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200 transition-colors"
            >
              <TranslateIcon size="xs" /> Translate
            </button>
          ) : (
            <button
              onClick={onTranslate}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-200 transition-colors"
            >
              <RefreshIcon size="xs" /> Re-translate
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-gray-100">
        <div className="p-4">
          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
            {field.ru_content || <NoContent />}
          </p>
        </div>
        <div className="p-4">
          <input
            type="text"
            value={draftValue}
            onChange={(e) => onChange(e.target.value)}
            disabled={isTranslating}
            placeholder={isTranslating ? "Translating…" : `Enter ${label} in English…`}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400"
          />
        </div>
      </div>
    </div>
  );
}

// ── Linked metaobjects section ─────────────────────────────────────────────
// Renders METAOBJECT records that are referenced by this resource via
// list.metaobject_reference or metaobject_reference metafields.
// Records are grouped by their metaobject type (first segment of handle).

/** Extract the metaobject type from a METAOBJECT record handle ("faq/my-faq" → "faq"). */
function moTypeFromHandle(handle: string): string {
  return handle.split("/")[0] ?? handle;
}

/** Convert a raw metaobject type slug to a human-readable section label. */
function moTypeLabel(moType: string): string {
  // Strip "shopify--" prefix for built-in types, then humanise.
  const cleaned = moType.replace(/^shopify--/, "").replace(/-/g, " ");
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Human label for an individual field inside a metaobject entry. */
function moFieldLabel(fieldKey: string): string {
  const map: Record<string, string> = {
    question: "Question",
    answer: "Answer",
    title: "Title",
    name: "Name",
    body: "Body",
    description: "Description",
    summary: "Summary",
    label: "Label",
    value: "Value",
    content: "Content",
  };
  return map[fieldKey] ?? fieldKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pick the best field to use as the preview snippet in a collapsed entry header. */
function moPreviewField(fields: TranslationField[]): TranslationField | undefined {
  return (
    fields.find((f) => f.field === "question") ??
    fields.find((f) => f.field === "title") ??
    fields.find((f) => f.field === "name") ??
    fields[0]
  );
}

function LinkedMetaobjectsSection({
  faqRecords,
  faqDrafts,
  isTranslating,
  onUpdate,
  onTranslateRecord,
}: {
  faqRecords: TranslationRecord[];
  faqDrafts: Record<string, Record<string, string>>;
  isTranslating: boolean;
  onUpdate: (recordId: string, fieldKey: string, value: string) => void;
  onTranslateRecord: (recordId: string) => void;
}) {
  const visibleRecords = faqRecords.filter((r) => r.fields.some((f) => f.ru_content?.trim()));
  if (!visibleRecords.length) return null;

  // Group records by metaobject type (first segment of handle).
  const groups = new Map<string, TranslationRecord[]>();
  for (const r of visibleRecords) {
    const moType = moTypeFromHandle(r.handle);
    if (!groups.has(moType)) groups.set(moType, []);
    groups.get(moType)!.push(r);
  }

  return (
    <>
      {[...groups.entries()].map(([moType, groupRecords]) => (
        <LinkedMetaobjectGroup
          key={moType}
          moType={moType}
          records={groupRecords}
          faqDrafts={faqDrafts}
          isTranslating={isTranslating}
          onUpdate={onUpdate}
          onTranslateRecord={onTranslateRecord}
        />
      ))}
    </>
  );
}

function LinkedMetaobjectGroup({
  moType,
  records,
  faqDrafts,
  isTranslating,
  onUpdate,
  onTranslateRecord,
}: {
  moType: string;
  records: TranslationRecord[];
  faqDrafts: Record<string, Record<string, string>>;
  isTranslating: boolean;
  onUpdate: (recordId: string, fieldKey: string, value: string) => void;
  onTranslateRecord: (recordId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(records.map((r) => r.id)));

  const totalMissing = records.reduce((sum, r) => {
    const draft = faqDrafts[r.id] ?? {};
    return sum + r.fields.filter(
      (f) => f.ru_content?.trim() && isEffectivelyEmpty(draft[f.field] ?? f.en_content ?? "")
    ).length;
  }, 0);

  function toggleEntry(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sectionLabel = moTypeLabel(moType);

  return (
    <div className="space-y-3">
      {/* Group header */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-amber-600 hover:text-amber-700 transition-colors"
        >
          <svg
            className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          {sectionLabel}
          <span className="text-amber-400 font-normal normal-case tracking-normal">
            ({records.length} {records.length === 1 ? "entry" : "entries"})
          </span>
          {totalMissing > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 text-amber-700 font-semibold">
              {totalMissing} missing
            </span>
          )}
        </button>
        <div className="flex-1 border-t border-amber-200" />
      </div>

      {open && records.map((rec, idx) => {
        const isExpanded = expandedIds.has(rec.id);
        const draft = faqDrafts[rec.id] ?? {};
        const fields = rec.fields.filter((f) => f.ru_content?.trim());
        const missingInEntry = fields.filter(
          (f) => isEffectivelyEmpty(draft[f.field] ?? f.en_content ?? "")
        ).length;
        const previewField = moPreviewField(fields);
        const previewText = previewField?.ru_content?.slice(0, 70) ?? `#${idx + 1}`;
        const busy = isTranslating || (rec.isTranslating ?? false);

        return (
          <div key={rec.id} className="border border-amber-200 rounded-xl overflow-hidden shadow-sm">
            {/* Entry header */}
            <div
              className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border-b border-amber-100 cursor-pointer select-none"
              onClick={() => toggleEntry(rec.id)}
            >
              <svg
                className={`w-3.5 h-3.5 text-amber-500 transition-transform shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-xs font-semibold text-amber-800 shrink-0">
                {sectionLabel} #{idx + 1}
              </span>
              <span className="text-xs text-amber-600 truncate flex-1 min-w-0">
                — {previewText}{previewField?.ru_content && previewField.ru_content.length > 70 ? "…" : ""}
              </span>
              {missingInEntry > 0 && (
                <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 text-amber-700 border border-amber-200 font-medium">
                  {missingInEntry} missing
                </span>
              )}
              <div className="ml-auto shrink-0 pl-2" onClick={(e) => e.stopPropagation()}>
                {busy ? (
                  <span className="flex items-center gap-1 text-xs text-indigo-500">
                    <Spinner size="sm" /> Translating…
                  </span>
                ) : missingInEntry > 0 ? (
                  <button
                    onClick={() => onTranslateRecord(rec.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200 transition-colors"
                  >
                    <TranslateIcon size="xs" /> Translate
                  </button>
                ) : (
                  <button
                    onClick={() => onTranslateRecord(rec.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-200 transition-colors"
                  >
                    <RefreshIcon size="xs" /> Re-translate
                  </button>
                )}
              </div>
            </div>

            {/* Fields */}
            {isExpanded && (
              <div className="divide-y divide-amber-100">
                {fields.map((field) => {
                  const draftVal = draft[field.field] ?? "";
                  const hasTranslation = !isEffectivelyEmpty(draftVal);
                  const fieldLabel = moFieldLabel(field.field);
                  return (
                    <div key={field.field}>
                      <div className="flex items-center gap-2 px-4 py-1.5 bg-white border-b border-amber-50">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                          {fieldLabel}
                        </span>
                        <FieldStatusDot status={hasTranslation ? "done" : "missing"} />
                      </div>
                      <div className="grid grid-cols-2 divide-x divide-amber-100">
                        <div className="p-3 bg-white">
                          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                            {field.ru_content || <NoContent />}
                          </p>
                        </div>
                        <div className="p-3 bg-white">
                          <textarea
                            value={draftVal}
                            onChange={(e) => onUpdate(rec.id, field.field, e.target.value)}
                            disabled={busy}
                            rows={Math.max(2, Math.ceil((field.ru_content?.length ?? 0) / 80))}
                            placeholder={busy ? "Translating…" : `Enter ${fieldLabel} in English…`}
                            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-300 placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 resize-y"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Field grouping ─────────────────────────────────────────────────────────

type FieldGroup = "Core" | "SEO" | "Product Organization" | "Metafields";

const FIELD_GROUP_MAP: Record<string, FieldGroup> = {
  title:            "Core",
  name:             "Core",
  body_html:        "Core",
  body:             "Core",  // ShopPolicy and other resources use "body" (not body_html)
  description:      "Core",
  content:          "Core",
  meta_title:       "SEO",
  meta_description: "SEO",
};

function groupForField(fieldKey: string): FieldGroup {
  if (fieldKey.startsWith("meta.")) return "Metafields";
  return FIELD_GROUP_MAP[fieldKey] ?? "Product Organization";
}

const GROUP_ORDER: FieldGroup[] = ["Core", "SEO", "Product Organization", "Metafields"];

function GroupHeader({ label }: { label: FieldGroup }) {
  const colors: Record<FieldGroup, string> = {
    Core:       "text-gray-500 border-gray-200",
    SEO:        "text-violet-500 border-violet-200",
    "Product Organization": "text-gray-400 border-gray-200",
    Metafields: "text-teal-600 border-teal-200",
  };
  return (
    <div className={`flex items-center gap-3 pt-1`}>
      <span className={`text-[10px] font-semibold uppercase tracking-widest ${colors[label].split(" ")[0]}`}>
        {label}
      </span>
      <div className={`flex-1 border-t ${colors[label].split(" ")[1]}`} />
    </div>
  );
}

function GroupedFields({
  fields,
  draftFields,
  isTranslating,
  recordType,
  updateField,
  onTranslateSingleField,
}: {
  fields: TranslationField[];
  draftFields: TranslationField[];
  isTranslating: boolean;
  recordType: string;
  updateField: (field: string, value: string) => void;
  onTranslateSingleField: (fieldKey: string, ruContent: string, fieldType: FieldType, force: boolean) => void;
}) {
  const byGroup = new Map<FieldGroup, TranslationField[]>();
  for (const f of fields) {
    const g = groupForField(f.field);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(f);
  }

  // Product Organization fields (product_type, vendor, tags, etc.) are
  // only meaningful for PRODUCT records — hide them for all other types.
  const isProduct = recordType === "PRODUCT";

  return (
    <>
      {GROUP_ORDER.filter((g) => byGroup.has(g) && (g !== "Product Organization" || isProduct)).map((group) => (
        <div key={group} className="space-y-4">
          <GroupHeader label={group} />
          {byGroup.get(group)!.map((field) => (
            <FieldBlock
              key={field.field}
              field={field}
              draftValue={draftFields.find((f) => f.field === field.field)?.en_content ?? ""}
              isTranslating={isTranslating}
              onChange={(val) => updateField(field.field, val)}
              onTranslateField={
                field.ru_content
                  ? (force) => onTranslateSingleField(field.field, field.ru_content, field.fieldType, force)
                  : undefined
              }
            />
          ))}
        </div>
      ))}
    </>
  );
}

// ── Field block ────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  name: "Title",
  body_html: "Body (HTML)",
  body: "Body (HTML)",
  description: "Description (HTML)",
  content: "Content (HTML)",
  meta_title: "Meta Title",
  meta_description: "Meta Description",
  product_type: "Product Type",
  alt: "Image Alt Text",
  value: "Value",
  summary: "Summary",
  subtitle: "Subtitle",
};

/** Derive a human-readable label for any field key, including dynamic meta.* keys. */
function labelForKey(fieldKey: string): string {
  if (FIELD_LABELS[fieldKey]) return FIELD_LABELS[fieldKey];
  if (fieldKey.startsWith("meta.")) {
    // "meta.custom.some_key" → "Some Key"
    const parts = fieldKey.split(".");
    const raw = parts[parts.length - 1] ?? fieldKey;
    return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return fieldKey;
}

const CHAR_LIMITS: Record<string, number> = {
  meta_title: 60,
  meta_description: 160,
};

function FieldBlock({
  field,
  draftValue,
  isTranslating,
  onChange,
  onTranslateField,
}: {
  field: TranslationField;
  draftValue: string;
  isTranslating: boolean;
  onChange: (val: string) => void;
  onTranslateField?: (force: boolean) => void;
}) {
  const [isFieldTranslating, setIsFieldTranslating] = useState(false);
  const [sourceMode, setSourceMode] = useState<"rich" | "html">("rich");
  // Shared expand state — both source and translation panels expand/collapse together.
  const [expanded, setExpanded] = useState(false);
  const label = (field.displayName?.trim() || labelForKey(field.field));
  const isHtml = field.fieldType === "html";
  const charLimit = CHAR_LIMITS[field.field];
  const charCount = draftValue.replace(/<[^>]*>/g, "").length;
  const overLimit = charLimit != null && charCount > charLimit;
  const hasContent = !isEffectivelyEmpty(draftValue);
  const busy = isTranslating || isFieldTranslating;

  async function handleFieldTranslate(force: boolean) {
    if (!onTranslateField) return;
    setIsFieldTranslating(true);
    await onTranslateField(force);
    setIsFieldTranslating(false);
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      {/* Field label bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{label}</span>
        {field.namespaceKey && (
          <span className="text-[10px] text-gray-400 font-mono">{field.namespaceKey}</span>
        )}
        <FieldStatusDot status={field.status} />
        {field.csvStatus === "outdated" && (
          <span className="text-xs text-orange-600 font-medium bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded">
            outdated
          </span>
        )}
        {field.status === "missing" && (
          <span className="text-xs text-amber-600 font-medium bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
            missing
          </span>
        )}
        {charLimit && draftValue && (
          <span className={`text-xs tabular-nums ${overLimit ? "text-red-500 font-semibold" : "text-gray-400"}`}>
            {charCount} / {charLimit}
          </span>
        )}

        {/* Per-field translate button — right side */}
        {onTranslateField && (
          <div className="ml-auto flex items-center gap-1">
            {isFieldTranslating ? (
              <span className="flex items-center gap-1 text-xs text-indigo-500">
                <Spinner size="sm" /> Translating…
              </span>
            ) : (
              <>
                {!hasContent ? (
                  <button
                    onClick={() => handleFieldTranslate(false)}
                    disabled={busy}
                    title="Translate this field"
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200 transition-colors disabled:opacity-40"
                  >
                    <TranslateIcon size="xs" /> Translate
                  </button>
                ) : (
                  <button
                    onClick={() => handleFieldTranslate(true)}
                    disabled={busy}
                    title="Re-translate this field (will overwrite)"
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-200 transition-colors disabled:opacity-40"
                  >
                    <RefreshIcon size="xs" /> Re-translate
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Source above translation on mobile, side-by-side on sm+ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
        {/* Source (read-only) */}
        <div className="p-4">
          {isHtml ? (
            field.ru_content ? (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center gap-0.5 px-2 py-1.5 bg-gray-50 border-b border-gray-200 flex-wrap">
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSourceMode((m) => (m === "rich" ? "html" : "rich"))}
                      className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
                        sourceMode === "html"
                          ? "bg-gray-800 border-gray-800 text-white"
                          : "bg-white border-gray-200 text-gray-600 hover:bg-gray-100"
                      }`}
                      title={sourceMode === "html" ? "Switch to rich view" : "Switch to HTML code view"}
                      aria-label={sourceMode === "html" ? "Switch to rich view" : "Switch to HTML code view"}
                    >
                      {"</>"}
                    </button>
                  </div>
                </div>
                <div className="px-4 py-3 bg-white sm:min-h-[17.5rem]">
                  {sourceMode === "rich" ? (
                    <div
                      className="prose prose-sm max-w-none text-sm text-gray-700 overflow-y-auto sm:min-h-[17.5rem]"
                      dangerouslySetInnerHTML={{ __html: field.ru_content }}
                    />
                  ) : (
                    <pre
                      className="text-sm font-mono bg-gray-50 rounded p-3 overflow-auto whitespace-pre-wrap break-all text-gray-700 leading-relaxed sm:min-h-[17.5rem]"
                    >
                      {field.ru_content}
                    </pre>
                  )}
                </div>
              </div>
            ) : (
              <NoContent />
            )
          ) : (
            <CollapsibleSource text={field.ru_content ?? ""} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
          )}
        </div>

        {/* Editable translation */}
        <div className="p-4">
          {isHtml ? (
            <RichTextEditor
              value={draftValue}
              onChange={onChange}
              disabled={isTranslating}
              placeholder={isTranslating ? "Translating…" : `Enter ${label} in English…`}
              minRows={5}
            />
          ) : field.fieldType === "seo_desc" ? (
            <textarea
              value={draftValue}
              onChange={(e) => onChange(e.target.value)}
              disabled={isTranslating}
              rows={3}
              placeholder={isTranslating ? "Translating…" : `Enter ${label}…`}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 resize-y"
            />
          ) : (field.ru_content?.length ?? 0) > COLLAPSE_THRESHOLD ? (
            // Long plain-text field — mirror the source panel's collapse state so
            // both sides expand/collapse together when either "Show more" is clicked.
            <div>
              <textarea
                value={draftValue}
                onChange={(e) => onChange(e.target.value)}
                disabled={isTranslating}
                rows={expanded ? 8 : 3}
                placeholder={isTranslating ? "Translating…" : `Enter ${label}…`}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400 resize-y transition-all"
              />
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            </div>
          ) : (
            <input
              type="text"
              value={draftValue}
              onChange={(e) => onChange(e.target.value)}
              disabled={isTranslating}
              placeholder={isTranslating ? "Translating…" : `Enter ${label}…`}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-gray-300 disabled:bg-gray-50 disabled:text-gray-400"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────

/** Collapses plain-text source content to 4 lines when it's long, with a toggle.
 *  Controlled: pass expanded + onToggle so FieldBlock can sync both panels. */
const COLLAPSE_THRESHOLD = 300;
function CollapsibleSource({
  text,
  expanded,
  onToggle,
}: {
  text: string;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isControlled = expanded !== undefined && onToggle !== undefined;
  const isOpen = isControlled ? expanded : localExpanded;
  const toggle = isControlled ? onToggle : () => setLocalExpanded((v) => !v);

  if (!text) return <NoContent />;
  const isLong = text.length > COLLAPSE_THRESHOLD;
  return (
    <div>
      <p
        className={`text-sm text-gray-800 leading-relaxed whitespace-pre-wrap ${
          isLong && !isOpen ? "line-clamp-4" : ""
        }`}
      >
        {text}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={toggle}
          className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          {isOpen ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function NoContent() {
  return <span className="text-gray-300 italic text-xs">No content</span>;
}

function FieldStatusDot({ status }: { status: TranslationField["status"] }) {
  const colors = { done: "bg-green-400", outdated: "bg-orange-400", missing: "bg-gray-300" };
  return <span className={`w-1.5 h-1.5 rounded-full ${colors[status]}`} />;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs font-mono font-medium">
      {type}
    </span>
  );
}

function resolveShelfStatus(record: TranslationRecord): "Active" | "Draft" | null {
  const rs = record.shopifyResourceStatus;
  if (rs === "ACTIVE") return "Active";
  if (rs === "DRAFT") return "Draft";
  if (record.shopifyPublishedAt !== undefined) {
    return record.shopifyPublishedAt ? "Active" : "Draft";
  }
  return null;
}

function StatusBadge({ status }: { status: TranslationRecord["status"] }) {
  const styles = {
    translated: "bg-green-100 text-green-700",
    outdated: "bg-orange-100 text-orange-700",
    partial: "bg-blue-100 text-blue-700",
    new: "bg-amber-100 text-amber-700",
  };
  const labels = { translated: "Translated", outdated: "Outdated", partial: "Partial", new: "Not translated" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
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


function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  return <UiSpinner className={size === "sm" ? "w-3 h-3" : "w-4 h-4"} />;
}

