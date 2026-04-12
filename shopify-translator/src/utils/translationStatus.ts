import type { TranslationField, TranslationStatus } from "@/types";
import { isEffectivelyEmpty } from "@/utils/isEffectivelyEmpty";

/** Alias for EN-field checks; same implementation as {@link isEffectivelyEmpty}. */
export const isEffectivelyEmptyEn = isEffectivelyEmpty;

/**
 * Coarse EN coverage for title + body (en_title / en_body), using `title`|`name` and `body_html` fields.
 */
export function deriveTranslationStatus(fields: TranslationField[]): TranslationStatus {
  const titleField = fields.find((f) => f.field === "title" || f.field === "name");
  const bodyField = fields.find((f) => f.field === "body_html");
  const tOk = titleField ? !isEffectivelyEmpty(titleField.en_content) : false;
  const bOk = bodyField ? !isEffectivelyEmpty(bodyField.en_content) : false;
  const hasTitle = titleField !== undefined;
  const hasBody = bodyField !== undefined;

  if (!hasTitle && !hasBody) {
    const anyEn = fields.some((f) => !isEffectivelyEmpty(f.en_content));
    return anyEn ? "partial" : "missing";
  }
  if (hasTitle && !hasBody) return tOk ? "complete" : "missing";
  if (!hasTitle && hasBody) return bOk ? "complete" : "missing";
  if (!tOk && !bOk) return "missing";
  if (tOk && bOk) return "complete";
  return "partial";
}
