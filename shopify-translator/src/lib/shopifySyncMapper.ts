/**
 * Pure mapping layer — no API calls.
 * Classifies translatableContent keys into editor groups, generates labels,
 * and decides which keys are skippable.
 */

// ── Exclusion list ───────────────────────────────────────────────────────

/**
 * Keys that are never meaningful to translate.
 * "url" and "handle" are structural identifiers.
 * "__display_title__" is a synthetic internal field injected by the mapper.
 */
export const SKIP_FIELDS = new Set<string>(["url", "handle", "__display_title__"]);

// ── Static group + label tables ──────────────────────────────────────────

/** Known static keys → editor section name */
export const FIELD_GROUP_MAP: Record<string, string> = {
  title: "Content",
  body_html: "Content",
  vendor: "Content",
  product_type: "Content",
  meta_title: "SEO",
  meta_description: "SEO",
};

/** Human-readable labels for known static keys */
export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  body_html: "Body (HTML)",
  vendor: "Vendor",
  product_type: "Product Type",
  meta_title: "SEO Title",
  meta_description: "SEO Description",
};

// ── Predicates ───────────────────────────────────────────────────────────

/** Returns false for any key that should be excluded from translation. */
export function isTranslatableField(key: string): boolean {
  return !SKIP_FIELDS.has(key);
}

/**
 * Returns true when the key is an image alt field.
 * Shopify key format: image.<mediaImageGid>.alt
 * e.g.  image.gid://shopify/MediaImage/12345678.alt
 */
export function isImageAltKey(key: string): boolean {
  return /^image\..+\.alt$/.test(key);
}

// ── Derived metadata ─────────────────────────────────────────────────────

/**
 * Maps a translatableContent key to its editor section group.
 *   image.*.alt  → "Images"
 *   known static → from FIELD_GROUP_MAP
 *   anything else → "Other"
 */
export function getFieldGroup(key: string): string {
  if (isImageAltKey(key)) return "Images";
  return FIELD_GROUP_MAP[key] ?? "Other";
}

/**
 * Returns a human-readable label for a translatableContent key.
 * For image alt keys, parses the numeric ID from the Shopify GID:
 *   image.gid://shopify/MediaImage/12345678.alt → "Image #12345678"
 */
export function getFieldLabel(key: string): string {
  if (isImageAltKey(key)) {
    const match = key.match(/\/(\d+)\.alt$/);
    return match ? `Image #${match[1]}` : "Image alt";
  }
  return FIELD_LABELS[key] ?? key;
}

/**
 * Extracts the numeric Shopify MediaImage ID from an image alt key.
 *   image.gid://shopify/MediaImage/12345678.alt → "12345678"
 * Returns null if the key is not a recognised image alt key.
 */
export function getImageNumericId(key: string): string | null {
  const match = key.match(/\/(\d+)\.alt$/);
  return match ? match[1] : null;
}
