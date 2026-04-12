/**
 * Human-readable language labels for settings UI.
 * Codes remain BCP-47 / ISO (passed to /api/translate); labels are for display only.
 */

const TARGET_LOCALE_CODES = [
  "en",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "pl",
  "pt",
  "pt-BR",
  "ja",
  "ko",
  "zh-CN",
  "zh-TW",
  "ar",
  "ru",
  "tr",
  "sv",
  "da",
  "fi",
  "no",
  "cs",
  "el",
  "he",
  "hi",
  "id",
  "ms",
  "th",
  "uk",
  "vi",
] as const;

let displayNamesEn: Intl.DisplayNames | null = null;
function getDisplayNames(): Intl.DisplayNames {
  if (!displayNamesEn) {
    displayNamesEn = new Intl.DisplayNames(["en"], { type: "language" });
  }
  return displayNamesEn;
}

/** Normalize Shopify / user locale strings for storage (lowercase, hyphen). */
export function normalizeLocaleCode(raw: string): string {
  const t = raw.trim().replace(/_/g, "-");
  if (!t) return "en";
  const parts = t.split("-");
  if (parts.length === 1) return parts[0].toLowerCase();
  return `${parts[0].toLowerCase()}-${parts.slice(1).join("-")}`;
}

/** English display name for a language tag (e.g. `ru` → "Russian"). */
export function languageLabelForCode(code: string): string {
  const normalized = normalizeLocaleCode(code);
  if (!normalized) return "—";
  try {
    const label = getDisplayNames().of(normalized);
    if (label) return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    /* fall through */
  }
  const base = normalized.split("-")[0];
  try {
    const label = getDisplayNames().of(base);
    if (label) return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    /* ignore */
  }
  return normalized;
}

export interface TargetLanguageOption {
  value: string;
  label: string;
}

/** Sorted dropdown options for "translate to" language. */
export function getTargetLanguageOptions(): TargetLanguageOption[] {
  const opts = TARGET_LOCALE_CODES.map((value) => ({
    value,
    label: languageLabelForCode(value),
  }));
  return [...opts].sort((a, b) => a.label.localeCompare(b.label, "en"));
}
