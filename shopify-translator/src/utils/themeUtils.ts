import type { TranslationField } from "@/types";

// ── Value filter ──────────────────────────────────────────────────────────────

/**
 * Returns true only for values that are meaningful human-readable text worth
 * translating. Skips image URLs, hex colours, booleans, pure numbers, icon
 * class names, and empty strings.
 */
export function isTranslatableValue(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") return false;
  const v = value.trim();
  if (v.length <= 1) return false;
  if (v.startsWith("#")) return false;               // hex colour
  if (v.startsWith("fa ") || v.startsWith("fa-")) return false; // icon class
  if (/^(true|false)$/i.test(v)) return false;       // boolean string
  if (/^\d+(\.\d+)?$/.test(v)) return false;         // pure number
  if (/^https?:\/\//i.test(v)) return false;         // URL
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(v)) return false; // file ref
  return true;
}

// ── Section → page context ────────────────────────────────────────────────────

/**
 * Infers the storefront page URL pattern from a Shopify theme section ID
 * OR a locale-file / app namespace.
 *
 * Handles:
 *   • section.{sectionId} / sections.{sectionId} — template section IDs
 *   • locale-file namespaces: cart, product, checkout, customer, …
 *   • app namespaces: socialshopwave.*, shopify.*
 */
export function inferPageContext(sectionId: string): string {
  const s = sectionId.toLowerCase();

  // ── App / system namespaces ───────────────────────────────────────────────
  if (s.startsWith("socialshopwave") || s === "wishlist") return "apps";
  if (s.startsWith("shopify") && s !== "shopify") return "shopify-system";

  // ── Exact locale-file namespace matches ───────────────────────────────────
  if (s === "cart" || s === "cart-template") return "/cart";
  if (s === "product" || s === "products") return "/products/*";
  if (s === "collection" || s === "collections") return "/collections/*";
  if (s === "blog" || s === "blogs" || s === "blog-template") return "/blogs/*";
  if (s === "article" || s === "articles" || s === "article-template") return "/blogs/*/articles/*";
  if (s === "customer" || s === "account" || s === "customer_accounts") return "/account/*";
  if (s === "checkout") return "/checkout";
  if (s === "search") return "/search";
  if (s === "gift_card" || s === "gift-card") return "/gift_cards/*";
  if (s === "password") return "/password";
  if (s === "404") return "/404";
  if (s === "index" || s === "home") return "/";

  // ── Named page templates ──────────────────────────────────────────────────
  if (s === "faq" || s === "faq-template") return "/pages/faq";
  if (s === "about" || s === "about-template" || s === "about-us") return "/pages/about";
  if (s === "wishlist-template") return "/pages/wishlist";
  if (s.includes("privacy")) return "/pages/privacy-policy";
  if (s.includes("return") && s.includes("polic")) return "/pages/return-policy";
  if (s.includes("shipping") && s.includes("polic")) return "/pages/shipping-policy";
  if (s.includes("terms")) return "/pages/terms-conditions";
  if (s.includes("payment") && s.includes("polic")) return "/pages/payment-policy";
  if (s === "list-collection-template" || s === "list-collections") return "/collections/*";

  // ── Section ID substring patterns ────────────────────────────────────────
  if (s.includes("contact")) return "/pages/contact-us";
  if (s.includes("faq")) return "/pages/faq";
  if (s.includes("about")) return "/pages/about";
  if (s.includes("wishlist")) return "/pages/wishlist";
  if (s.includes("article")) return "/blogs/*/articles/*";
  if (s.includes("blog")) return "/blogs/*";
  if (s.includes("list-collection") || s.includes("list_collection")) return "/collections/*";
  if (s.includes("collection")) return "/collections/*";
  if (s.includes("product")) return "/products/*";
  if (s.includes("cart")) return "/cart";
  if (s.includes("checkout")) return "/checkout";
  if (s.includes("account") || s.includes("login") || s.includes("register")) return "/account/*";
  if (s.includes("customer")) return "/account/*";
  if (s.includes("search")) return "/search";
  if (s.includes("404") || s.includes("not-found")) return "/404";
  if (s.includes("index") || s.includes("home")) return "/";
  if (s.includes("privacy")) return "/pages/privacy-policy";
  if (s.includes("shipping")) return "/pages/shipping-policy";
  if (s.includes("terms")) return "/pages/terms-conditions";

  return "theme-wide";
}

/**
 * Converts a section/block ID like "contact-template" or "1537611143786"
 * into a readable label.
 * For named IDs this is sufficient; for numeric IDs prefer inferSectionName()
 * which can inspect field keys for a better name.
 */
export function humanizeSectionId(id: string): string {
  if (/^\d+$/.test(id)) return `Block ${id.slice(-4)}`; // numeric ID — abbreviate
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns a human-readable section name.
 *
 * - Non-numeric IDs are title-cased (same as humanizeSectionId).
 * - Numeric IDs are inferred from the setting keys that belong to the section
 *   so the label is meaningful without any store-specific config.
 *
 * @param sectionId  Raw Shopify section ID (may be numeric or slug-like).
 * @param keys       The settingKey values of all fields in this section —
 *                   used as hints when the ID is a bare number.
 */
/** Capitalize first letter, replace underscores/hyphens with spaces. */
function titleCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

// Friendly labels for shopify.* sub-namespace keys
const SHOPIFY_SUB_LABELS: Record<string, string> = {
  cart:               "Cart",
  checkout:           "Checkout",
  filters:            "Filters",
  search:             "Search",
  addresses:          "Addresses",
  attributes:         "Attributes",
  collections:        "Collections",
  errors:             "Errors",
  links:              "Links",
  notices:            "Notices",
  page_titles:        "Page Titles",
  pagination:         "Pagination",
  sentence:           "Sentence",
  store_availability: "Store Availability",
  subscriptions:      "Subscriptions",
  email_marketing:    "Email Marketing",
  feed:               "Feed",
  challenge:          "Challenge",
  checkpoint:         "Checkpoint",
};

export function inferSectionName(sectionId: string, keys: string[]): string {
  // ── shopify-{sub} ──────────────────────────────────────────────────────────
  if (sectionId.startsWith("shopify-")) {
    const sub = sectionId.slice("shopify-".length);
    return `Shopify · ${SHOPIFY_SUB_LABELS[sub] ?? titleCase(sub)}`;
  }

  // ── socialshopwave-{sub} ───────────────────────────────────────────────────
  if (sectionId.startsWith("socialshopwave-")) {
    const sub = sectionId.slice("socialshopwave-".length);
    return `SocialShopWave · ${titleCase(sub)}`;
  }

  // ── customer_accounts-{sub} ────────────────────────────────────────────────
  if (sectionId.startsWith("customer_accounts-")) {
    const sub = sectionId.slice("customer_accounts-".length);
    return `Customer Accounts · ${titleCase(sub)}`;
  }

  // ── Named (non-numeric) IDs ────────────────────────────────────────────────
  if (!/^\d+$/.test(sectionId)) {
    return titleCase(sectionId);
  }

  // ── Numeric ID — infer from field keys ────────────────────────────────────
  const joined = keys.join(" ").toLowerCase();

  if (joined.includes("slide"))        return "Slider";
  if (joined.includes("banner"))       return "Banner";
  if (joined.includes("testimonial"))  return "Testimonial";
  if (joined.includes("hero"))         return "Hero";
  if (joined.includes("newsletter"))   return "Newsletter";
  if (joined.includes("instagram"))    return "Instagram";
  if (joined.includes("faq"))          return "FAQ";
  if (joined.includes("blog"))         return "Blog";
  if (joined.includes("product"))      return "Product";
  if (joined.includes("collection"))   return "Collection";
  if (joined.includes("promo"))        return "Promo";
  if (joined.includes("deal"))         return "Deal";
  if (joined.includes("footer"))       return "Footer";
  if (joined.includes("header"))       return "Header";
  if (joined.includes("copyright"))    return "Copyright";

  // Fallback — short suffix so it's still unique in the list
  return `Custom Block ${sectionId.slice(-6)}`;
}

/** Converts a setting key like "info_title" → "Info title" */
export function humanizeSettingKey(key: string): string {
  return key.replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ── Key parser ────────────────────────────────────────────────────────────────

export interface ParsedThemeKey {
  sectionId: string | null;
  blockId: string | null;
  settingKey: string;
  /** Raw original key, preserved for storage/push. */
  raw: string;
}

/**
 * Parses a Shopify theme translatable-content key into its structural parts.
 *
 * Supported patterns (in priority order):
 *   sections.{id}.blocks.{blockId}.settings.{key}  → schema block setting  (plural)
 *   sections.{id}.settings.{key}                   → schema section setting (plural)
 *   sections.{id}.{rest}                           → section locale t: key  (plural)
 *   section.{id}.{rest}                            → section locale t: key  (singular — common in themes)
 *   {namespace}.{rest}                             → locale-file key (cart.*, product.*, …)
 *   {bare key}                                     → top-level / unstructured
 */
export function parseThemeFieldKey(key: string): ParsedThemeKey {
  // sections.<sectionId>.blocks.<blockId>.settings.<settingKey>  (plural)
  const blockMatch = key.match(/^sections\.([^.]+)\.blocks\.([^.]+)\.settings\.(.+)$/);
  if (blockMatch) {
    return { sectionId: blockMatch[1], blockId: blockMatch[2], settingKey: blockMatch[3], raw: key };
  }

  // sections.<sectionId>.settings.<settingKey>  (plural)
  const sectionSettingsMatch = key.match(/^sections\.([^.]+)\.settings\.(.+)$/);
  if (sectionSettingsMatch) {
    return { sectionId: sectionSettingsMatch[1], blockId: null, settingKey: sectionSettingsMatch[2], raw: key };
  }

  // sections.<sectionId>.<anything>  (plural — locale t: key under a section)
  const sectionsLocaleMatch = key.match(/^sections\.([^.]+)\.(.+)$/);
  if (sectionsLocaleMatch) {
    return { sectionId: sectionsLocaleMatch[1], blockId: null, settingKey: sectionsLocaleMatch[2], raw: key };
  }

  // section.<sectionId>.<anything>  (singular — used by many Shopify themes)
  const sectionSingularMatch = key.match(/^section\.([^.]+)\.(.+)$/);
  if (sectionSingularMatch) {
    return { sectionId: sectionSingularMatch[1], blockId: null, settingKey: sectionSingularMatch[2], raw: key };
  }

  // Locale-file key: <namespace>.<rest>  (e.g. cart.general.title, socialshopwave.wishlist.*)
  // Use the namespace as sectionId so inferPageContext can route it.
  const dotIdx = key.indexOf(".");
  if (dotIdx > 0) {
    const namespace = key.slice(0, dotIdx);
    const rest = key.slice(dotIdx + 1);
    return { sectionId: namespace, blockId: null, settingKey: rest, raw: key };
  }

  // Bare key with no dots — truly top-level
  return { sectionId: null, blockId: null, settingKey: key, raw: key };
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export interface ThemeFieldEntry {
  parsed: ParsedThemeKey;
  field: TranslationField;
}

export interface ThemeBlockGroup {
  blockId: string | null;
  label: string;
  entries: ThemeFieldEntry[];
}

export interface ThemeSectionGroup {
  sectionId: string | null;
  label: string;
  pageContext: string;
  blocks: ThemeBlockGroup[];
}

export interface ThemePageGroup {
  pageContext: string;
  /** Human-readable page label, e.g. "/products/*" or "Theme-wide" */
  label: string;
  sections: ThemeSectionGroup[];
}

const PAGE_CONTEXT_LABELS: Record<string, string> = {
  "/": "Homepage",
  "/products/*": "Product pages",
  "/collections/*": "Collection pages",
  "/blogs/*": "Blog pages",
  "/blogs/*/articles/*": "Article pages",
  "/pages/contact-us": "Contact page",
  "/pages/faq": "FAQ page",
  "/pages/about": "About page",
  "/pages/wishlist": "Wishlist page",
  "/pages/privacy-policy": "Privacy policy",
  "/pages/return-policy": "Return policy",
  "/pages/shipping-policy": "Shipping policy",
  "/pages/terms-conditions": "Terms & conditions",
  "/pages/payment-policy": "Payment policy",
  "/cart": "Cart",
  "/checkout": "Checkout",
  "/account/*": "Account pages",
  "/search": "Search",
  "/gift_cards/*": "Gift cards",
  "/password": "Password page",
  "/404": "404 page",
  "apps": "Apps (third-party)",
  "shopify-system": "Shopify system",
  "theme-wide": "Theme-wide (header / footer / global)",
};

export function pageContextLabel(ctx: string): string {
  return PAGE_CONTEXT_LABELS[ctx] ?? ctx;
}

/**
 * Multi-level locale-file namespaces that should be split by their second
 * key segment so each sub-group becomes its own collapsible section.
 *
 * e.g. shopify.cart.general.title → sectionId "shopify-cart"
 *      socialshopwave.wishlist.add → sectionId "socialshopwave-wishlist"
 */
const SPLIT_NAMESPACES = new Set(["shopify", "socialshopwave", "customer_accounts"]);

/**
 * Derives the effective section identifier for a parsed key.
 * For split namespaces, combines the namespace with the first segment of
 * settingKey (e.g. "shopify" + "cart.general.title" → "shopify-cart").
 */
function effectiveSectionId(parsed: ParsedThemeKey): string | null {
  if (!parsed.sectionId) return null;
  if (SPLIT_NAMESPACES.has(parsed.sectionId)) {
    const sub = parsed.settingKey.split(".")[0] ?? "general";
    return `${parsed.sectionId}-${sub}`;
  }
  return parsed.sectionId;
}

/**
 * Groups a flat array of TranslationField (from a ONLINE_STORE_THEME record)
 * into a hierarchy: pageContext → section → block → fields.
 *
 * Filters out non-translatable source values before grouping.
 */
export function groupThemeFields(fields: TranslationField[]): ThemePageGroup[] {
  const pageMap = new Map<string, Map<string, ThemeSectionGroup>>();

  for (const f of fields) {
    if (f.field === "__display_title__") continue;  // synthetic field — display only
    if (!isTranslatableValue(f.ru_content)) continue;

    const parsed = parseThemeFieldKey(f.field);
    const secId = effectiveSectionId(parsed);
    const pageCtx = secId ? inferPageContext(secId) : "theme-wide";
    const sectionKey = secId ?? "__top__";
    const blockKey = parsed.blockId ?? "__section__";

    if (!pageMap.has(pageCtx)) pageMap.set(pageCtx, new Map());
    const sectionMap = pageMap.get(pageCtx)!;

    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, {
        sectionId: secId,
        label: secId ? humanizeSectionId(secId) : "Global",
        pageContext: pageCtx,
        blocks: [],
      });
    }
    const section = sectionMap.get(sectionKey)!;

    let block = section.blocks.find((b) => b.blockId === (parsed.blockId ?? null));
    if (!block) {
      block = {
        blockId: parsed.blockId ?? null,
        label: parsed.blockId ? humanizeSectionId(parsed.blockId) : "",
        entries: [],
      };
      section.blocks.push(block);
    }
    block.entries.push({ parsed, field: f });
  }

  // Post-process: re-label numeric section IDs now that all entries are known.
  for (const sectionMap of pageMap.values()) {
    for (const section of sectionMap.values()) {
      if (section.sectionId && /^\d+$/.test(section.sectionId)) {
        const keys = section.blocks.flatMap((b) => b.entries.map((e) => e.parsed.settingKey));
        section.label = inferSectionName(section.sectionId, keys);
      }
    }
  }

  const pages: ThemePageGroup[] = [];
  for (const [ctx, sectionMap] of pageMap) {
    pages.push({
      pageContext: ctx,
      label: pageContextLabel(ctx),
      sections: [...sectionMap.values()],
    });
  }

  // Sort: page-specific routes first, then apps/system/theme-wide last
  const LAST_BUCKETS = new Set(["apps", "shopify-system", "theme-wide"]);
  pages.sort((a, b) => {
    const aLast = LAST_BUCKETS.has(a.pageContext);
    const bLast = LAST_BUCKETS.has(b.pageContext);
    if (aLast !== bLast) return aLast ? 1 : -1;
    // theme-wide always after apps/shopify-system
    if (aLast && bLast) {
      if (a.pageContext === "theme-wide") return 1;
      if (b.pageContext === "theme-wide") return -1;
    }
    return a.label.localeCompare(b.label);
  });

  return pages;
}
