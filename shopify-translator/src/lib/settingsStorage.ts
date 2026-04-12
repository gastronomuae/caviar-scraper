import type { AppSettings } from "@/types";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT } from "@/lib/translationDefaults";

const SETTINGS_KEY = "shopify_translator_settings";

const DEFAULTS: AppSettings = {
  model: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  glossary: "",
  sourceLanguage: "ru",
  targetLanguage: "en",
  shopifyDomain: "",
  shopifyClientId: "",
  shopifyClientSecret: "",
  shopifyAccessToken: "",
  shopifyTokenExpiry: 0,
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/** True if the cached Shopify token is still valid (>5 min left). */
export function isTokenValid(s: AppSettings): boolean {
  return !!s.shopifyAccessToken && s.shopifyTokenExpiry > Date.now() + 5 * 60 * 1000;
}
