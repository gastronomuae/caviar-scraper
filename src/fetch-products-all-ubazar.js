/**
 * UBazar scraper — fetches product catalog from ubazar.ae category pages.
 *
 * Strategy: extract window.__NUXT__ state embedded in SSR HTML (via Node vm module).
 * This gives structured JSON including stable numeric product IDs, which are used as
 * the mapping key instead of URL slugs (slugs can change; IDs don't).
 *
 * Output handle = String(ubazar numeric id), e.g. "2038".
 * slug field = current URL slug, e.g. "pink-tomatoes-500g".
 * url = https://ubazar.ae/products/${slug}-${id}
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = 'https://ubazar.ae';
const OUT = path.join(__dirname, '..', 'Output', 'ubazar_products.latest.json');
const OUT_DELTA = path.join(__dirname, '..', 'Output', 'ubazar_delta.latest.json');
const MAPPING_PATH = path.join(__dirname, '..', 'data', 'ubazar_product_mapping.json');
const CATEGORY_INDEX_PATH = path.join(__dirname, '..', 'Output', 'ubazar_category_index.latest.json');

// Category page URLs to fetch products from.
const TARGET_CATEGORY_URLS = [
  `${BASE}/categories/vegetables-and-herbs-30`,
  `${BASE}/categories/fruits-32`,
  `${BASE}/categories/dried-fruitsnuts-36`,
];

// Known product IDs that are always fetched via direct API regardless of category scraping.
// Use this for products that live on page 2+ of category pages (UBazar SSR only embeds page 1
// in the Nuxt state, so paginated products are invisible to the HTML scraper).
const SEED_PRODUCT_IDS = [
  '118',  // Beet 500g
  '119',  // Radish green 500g
  '148',  // Potatoes red 500g
  '665',  // Potato 500g
  '985',  // Cabbage head 1kg
  '1670', // Eggplant 500g
  '2687', // Butternut Pumpkin 1kg
  '2688', // White Onion 500g
  '2696', // Red Onion 500g
  '757',  // Green onion 100g
];

function readJsonIfExistsSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonIfExists(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function fetchText(url) {
  const { data } = await axios.get(url, {
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    responseType: 'text',
    transformResponse: (x) => x
  });
  return String(data || '');
}

/**
 * Extract window.__NUXT__ state from SSR HTML using Node vm sandbox.
 * Returns the full state object or null on failure.
 */
function parseNuxtState(html) {
  const m = html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const sandbox = { __result: null };
    vm.runInNewContext(`__result = ${m[1]}`, sandbox, { timeout: 10000 });
    return sandbox.__result?.state || null;
  } catch (_) {
    return null;
  }
}

/**
 * Normalize a raw UBazar API product object into our internal format.
 * handle = stable numeric ID (survives slug renames).
 */
function normalizeApiProduct(p) {
  const id = p.id;
  if (!id) return null;
  const handle = String(id);
  const slugEn = String(p.slug_en || '');
  const url = `${BASE}/products/${slugEn}-${id}`;

  const priceRaw = p.price != null ? parseFloat(String(p.price)) : null;
  const oldPriceRaw = p.old_price != null ? parseFloat(String(p.old_price)) : null;

  // UBazar: price = current price, old_price = original price when on sale.
  // Map to our fields: promotional_price = current (sale) price, regular_price = original.
  const hasValidOldPrice = oldPriceRaw != null && Number.isFinite(oldPriceRaw) && oldPriceRaw > 0;
  const hasValidPrice = priceRaw != null && Number.isFinite(priceRaw) && priceRaw > 0;

  const promotional_price = hasValidOldPrice && hasValidPrice ? priceRaw : null;
  const regular_price = hasValidOldPrice ? oldPriceRaw : (hasValidPrice ? priceRaw : null);

  const inStock = p.in_stock != null ? Number(p.in_stock) : null;
  // Use in_stock as the primary availability signal.
  // active=no with stock > 0 still means available (UBazar may use active as a display toggle).
  // Only mark unavailable when stock is explicitly 0 (and not null/undefined).
  const available = inStock == null ? p.active === 'yes' : inStock > 0;

  let image = p.image || null;
  if (image && !image.startsWith('http')) {
    image = `https://apiv2.ubazar.ae/${image.replace(/^\//, '')}`;
  }

  return {
    handle,
    slug: slugEn,
    name: p.name_en || p.name_ru || slugEn,
    url,
    image,
    regular_price,
    promotional_price,
    available,
    ubazar_id: id
  };
}

/**
 * Fetch all products from a category URL including all pages via Nuxt state extraction.
 */
async function fetchCategoryProducts(url) {
  const html = await fetchText(url);
  const state = parseNuxtState(html);
  if (!state) throw new Error(`Could not parse Nuxt state from ${url}`);
  const raw = state?.pages?.products?.products;
  if (!Array.isArray(raw)) throw new Error(`No products array in Nuxt state for ${url}`);

  const products = raw.map(normalizeApiProduct).filter(Boolean);
  const totalPages = Number(state?.pages?.products?.productsNumberOfPages || 1);

  for (let page = 2; page <= Math.min(totalPages, 20); page++) {
    try {
      const sep = url.includes('?') ? '&' : '?';
      const pagedHtml = await fetchText(`${url}${sep}page=${page}`);
      const pagedState = parseNuxtState(pagedHtml);
      const pagedRaw = pagedState?.pages?.products?.products;
      if (!Array.isArray(pagedRaw) || pagedRaw.length === 0) break;
      for (const p of pagedRaw.map(normalizeApiProduct).filter(Boolean)) {
        products.push(p);
      }
    } catch (_) {
      break;
    }
  }

  return products;
}

function keyByHandle(row) {
  return row?.handle ? `h:${row.handle}` : null;
}

function diffRows(prev, next) {
  const a = new Map();
  const b = new Map();
  for (const r of prev || []) {
    const k = keyByHandle(r);
    if (k) a.set(k, r);
  }
  for (const r of next || []) {
    const k = keyByHandle(r);
    if (k) b.set(k, r);
  }
  const added = [];
  const removed = [];
  const updated = [];
  for (const [k, n] of b) {
    const p = a.get(k);
    if (!p) {
      added.push({ key: k, handle: n.handle, name: n.name || '' });
      continue;
    }
    const changed = [];
    const pushIf = (field, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) changed.push(field); };
    pushIf('promotional_price', p.promotional_price, n.promotional_price);
    pushIf('regular_price', p.regular_price, n.regular_price);
    pushIf('available', p.available, n.available);
    pushIf('name', p.name, n.name);
    pushIf('slug', p.slug, n.slug);
    if (changed.length) updated.push({ key: k, handle: n.handle, name: n.name || '', changed });
  }
  for (const [k, p] of a) {
    if (!b.has(k)) removed.push({ key: k, handle: p.handle, name: p.name || '' });
  }
  return { added, removed, updated };
}

/**
 * Discover the first category URL from the UBazar homepage nav.
 * The numeric suffix (e.g. `-4`) can change; this always finds the current live URL.
 * Returns null if discovery fails (non-blocking).
 */
async function discoverFirstCategoryUrl() {
  try {
    const html = await fetchText(BASE);
    // Match the first /categories/... href in the page (appears in nav dropdown)
    const m = html.match(/href="(\/categories\/[^"]+)"/);
    if (m) return `${BASE}${m[1]}`;
  } catch (_) {}
  return null;
}

async function fetchAllProducts() {
  const byId = new Map();
  /** Set of numeric IDs found on website category pages (not just API). */
  const websiteFoundIds = new Set();
  const categoryResults = [];

  // Discover the first category URL from the homepage (dynamic, handles URL changes).
  let discoveredCategoryUrl = null;
  try {
    discoveredCategoryUrl = await discoverFirstCategoryUrl();
  } catch (_) {}

  // Build the full list of category URLs to scrape.
  const allCategoryUrls = [...TARGET_CATEGORY_URLS];
  if (discoveredCategoryUrl && !allCategoryUrls.includes(discoveredCategoryUrl)) {
    allCategoryUrls.unshift(discoveredCategoryUrl); // Check homepage-discovered URL first
  }

  for (const catUrl of allCategoryUrls) {
    try {
      const products = await fetchCategoryProducts(catUrl);
      categoryResults.push({ url: catUrl, count: products.length });
      for (const p of products) {
        websiteFoundIds.add(p.handle);
        if (!byId.has(p.handle)) byId.set(p.handle, p);
      }
    } catch (e) {
      categoryResults.push({ url: catUrl, error: String(e.message || e) });
    }
  }

  // For mapped products not found via category pages, fetch them directly from the UBazar API.
  // This works even when the website SSR is down (e.g. rate-limiting itself with 429 errors).
  const mapping = readJsonIfExistsSafe(MAPPING_PATH, {});
  const prevProducts = readJsonIfExistsSafe(OUT, []);

  // Collect all known numeric IDs from: seed list + mapping + previous snapshot
  const knownIds = new Set([
    ...SEED_PRODUCT_IDS,
    ...Object.keys(mapping || {}).filter(k => /^\d+$/.test(String(k).trim())),
    ...(Array.isArray(prevProducts) ? prevProducts : []).map(p => String(p?.handle || '')).filter(k => /^\d+$/.test(k))
  ]);

  for (const id of knownIds) {
    if (byId.has(id)) continue;
    try {
      const { data } = await axios.get(`https://apiv2.ubazar.ae/api/product/${id}`, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
      });
      const prod = data?.message?.product;
      if (prod && prod.id) {
        const normalized = normalizeApiProduct(prod);
        if (normalized) {
          // Product found via API but NOT on any website category page.
          // Mark as unavailable so Gastronom reflects the website state.
          if (!websiteFoundIds.has(normalized.handle)) {
            normalized.available = false;
            normalized.website_visible = false;
          }
          byId.set(normalized.handle, normalized);
        }
      }
    } catch (_) {
      // Product gone or API unavailable — will be drafted.
    }
  }

  // Mark all website-found products explicitly.
  for (const [handle, p] of byId) {
    if (websiteFoundIds.has(handle)) p.website_visible = true;
  }

  try {
    fs.mkdirSync(path.dirname(CATEGORY_INDEX_PATH), { recursive: true });
    fs.writeFileSync(CATEGORY_INDEX_PATH, JSON.stringify({
      scraped_at: new Date().toISOString(),
      source: BASE,
      discovered_category_url: discoveredCategoryUrl,
      categories: categoryResults
    }, null, 2), 'utf8');
  } catch (_) {
    // best-effort
  }

  const products = [...byId.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en'));
  return { products, categoryResults, discoveredCategoryUrl };
}

async function main() {
  const { products, categoryResults, discoveredCategoryUrl } = await fetchAllProducts();
  if (discoveredCategoryUrl) console.log(`UBazar: discovered category URL: ${discoveredCategoryUrl}`);

  const prev = readJsonIfExists(OUT, []);
  const prevArr = Array.isArray(prev) ? prev : [];

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(products, null, 2), 'utf8');

  const delta = diffRows(prevArr, products);
  fs.writeFileSync(OUT_DELTA, JSON.stringify({
    scraped_at: new Date().toISOString(),
    source: BASE,
    categories: categoryResults,
    counts: { total: products.length, added: delta.added.length, removed: delta.removed.length, updated: delta.updated.length },
    delta
  }, null, 2), 'utf8');

  const hiddenCount = products.filter(p => p.website_visible === false).length;
  console.log(`UBazar: saved ${products.length} products -> ${OUT}`);
  if (hiddenCount > 0) console.log(`UBazar: ${hiddenCount} product(s) found via API only (not on website) → marked unavailable`);
  console.log(`UBazar delta: +${delta.added.length} ~${delta.updated.length} -${delta.removed.length} -> ${OUT_DELTA}`);
}

module.exports = { fetchAllProducts, normalizeApiProduct, parseNuxtState };

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}
