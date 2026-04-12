/**
 * App store identity and translation locales (Shopify sync, push, UI tooltips).
 * Adjust `store` if the Shopify shop handle differs (typically `{store}.myshopify.com`).
 */
export const STORE_CONFIG = {
  store: "gastronom",
  source_locale: "ru",
  target_locale: "en",
} as const;

export type StoreConfig = typeof STORE_CONFIG;

/** Alias for sync / fallback logic */
export const SOURCE_LOCALE = STORE_CONFIG.source_locale;
/** Alias for sync / push target locale */
export const TARGET_LOCALE = STORE_CONFIG.target_locale;
