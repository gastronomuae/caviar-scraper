// ── Translations API field ────────────────────────────────────────────────

/**
 * A single field from Shopify's translatableContent, enriched with editor metadata.
 * Covers all resource types (Content, SEO, Images, Other).
 */
export interface SyncedField {
  /** Shopify translatableContent key — e.g. "title", "image.gid://shopify/MediaImage/123.alt" */
  key: string;
  /** Source text (Russian) as returned by Shopify */
  sourceValue: string;
  /** Translated text (English) — populated after AI translation */
  translatedValue: string;
  /** Shopify content digest, required by translationsRegister */
  digest: string;
  /** Editor section: "Content" | "SEO" | "Images" | "Other" */
  group: string;
  /** Human-readable label rendered in the editor */
  label: string;
}

// ── Product ───────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  handle: string;
  /** CSV-sourced Russian fields */
  ru_title: string;
  ru_body: string;
  ru_meta_title: string;
  ru_meta_description: string;
  /** CSV-sourced English fields (editable) */
  en_title: string;
  en_body: string;
  en_meta_title: string;
  en_meta_description: string;
  status: "new" | "translated";
  isTranslating?: boolean;
  /** Shopify GID — populated after first sync */
  shopifyId?: string;
  /** Fields from Shopify Translations API (image alts, etc.) */
  syncedFields?: SyncedField[];
  /** Numeric MediaImage ID → CDN URL, for thumbnail display in editor */
  imageUrlMap?: Record<string, string>;
}

// ── CSV helpers ───────────────────────────────────────────────────────────

export interface RawCSVRow {
  Handle?: string;
  Title?: string;
  "Body (HTML)"?: string;
  "SEO Title"?: string;
  "SEO Description"?: string;
  [key: string]: string | undefined;
}
