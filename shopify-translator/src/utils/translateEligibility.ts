import type { TranslationRecord } from "@/types";
import { isTranslatableField } from "@/utils/csvParser";
import { isEffectivelyEmpty } from "@/utils/isEffectivelyEmpty";

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  name: "Name",
  body_html: "Description",
  description: "Description",
  content: "Content",
  meta_title: "SEO title",
  meta_description: "SEO description",
  product_type: "Product type",
  value: "Value",
  alt: "Alt text",
  summary: "Summary",
  subtitle: "Subtitle",
};

function labelForField(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * Why "Translate" would send no fields with the usual skip-existing rules.
 * Typical case: list shows a Russian title but the row is Partial because the
 * description has no Russian in sync data — nothing is sent for the body.
 */
export function explainNoFieldsToTranslate(record: TranslationRecord, skipExisting: boolean): string {
  const parts: string[] = [];
  for (const f of record.fields) {
    if (!isTranslatableField(f.field)) continue;
    const hasRu = f.ru_content.trim().length > 0;
    if (!hasRu) {
      if (f.status === "missing" || f.status === "outdated") {
        parts.push(`${labelForField(f.field)}: no Russian source`);
      }
      continue;
    }
    if (skipExisting && !isEffectivelyEmpty(f.en_content) && f.status === "done") {
      parts.push(`${labelForField(f.field)}: English already filled`);
    }
  }
  if (parts.length === 0) {
    return "Add Russian source where needed, or use Retranslate to overwrite existing English.";
  }
  return parts.join(" · ");
}
