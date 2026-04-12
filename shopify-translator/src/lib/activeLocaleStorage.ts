/**
 * Active working locale — shared between SyncToolbar (writes) and any component
 * that needs to know the currently selected target locale (translate, push, mapper).
 *
 * Single source of truth: localStorage key per shop, same key used by Settings page
 * and SyncToolbar so they stay in sync automatically.
 */

/** localStorage key prefix for the active working locale per shop. Suffix = shopDomain. */
export const LOCALE_STORAGE_KEY_PREFIX = "localeflow_target_locale_";

/**
 * Returns the active working target locale for the current shop.
 *
 * Resolution order:
 *   1. localStorage[LOCALE_STORAGE_KEY_PREFIX + shopDomain]  (set by SyncToolbar / Settings)
 *   2. settings.targetLanguage from settingsStorage
 *   3. hard fallback "en"
 *
 * Call this immediately before any translate or push action so it reflects
 * any mid-session locale switch made via the Sync toolbar.
 *
 * @param shopDomain  optional — when omitted, reads shopifyDomain from settingsStorage
 */
export function readActiveLocale(shopDomain?: string): string {
  if (typeof window === "undefined") return "en";

  // Resolve shop domain
  let shop = shopDomain?.trim() ?? "";
  if (!shop) {
    try {
      const raw = localStorage.getItem("shopify_translator_settings");
      if (raw) {
        const parsed = JSON.parse(raw) as { shopifyDomain?: string };
        shop = parsed.shopifyDomain?.trim() ?? "";
      }
    } catch { /* ignore */ }
  }

  // 1. Per-shop locale key (SyncToolbar + Settings page write here)
  if (shop) {
    try {
      const saved = localStorage.getItem(`${LOCALE_STORAGE_KEY_PREFIX}${shop}`);
      if (saved) return saved;
    } catch { /* ignore */ }
  }

  // 2. Settings targetLanguage fallback
  try {
    const raw = localStorage.getItem("shopify_translator_settings");
    if (raw) {
      const parsed = JSON.parse(raw) as { targetLanguage?: string };
      if (parsed.targetLanguage) return parsed.targetLanguage;
    }
  } catch { /* ignore */ }

  return "en";
}
