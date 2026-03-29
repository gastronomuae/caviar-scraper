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
    vm.runInNewContext(`__result = ${m[1]}`, sandbox, { timeout: 5000 });
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
  const available = p.active === 'yes' && (inStock == null || inStock > 0);

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

async function fetchAllProducts() {
  const byId = new Map();
  const categoryResults = [];

  for (const catUrl of TARGET_CATEGORY_URLS) {
    try {
      const products = await fetchCategoryProducts(catUrl);
      categoryResults.push({ url: catUrl, count: products.length });
      for (const p of products) {
        if (!byId.has(p.handle)) byId.set(p.handle, p);
      }
    } catch (e) {
      categoryResults.push({ url: catUrl, error: String(e.message || e) });
    }
  }

  // For mapped products not found via category pages, try fetching their page directly.
  // We check the previous snapshot for a known slug, then try to load that page by ID.
  const mapping = readJsonIfExistsSafe(MAPPING_PATH, {});
  const prevProducts = readJsonIfExistsSafe(OUT, []);
  const prevById = new Map((Array.isArray(prevProducts) ? prevProducts : []).map((p) => [String(p?.handle || ''), p]));
  const mappedIds = Object.keys(mapping || {}).map((k) => String(k).trim()).filter(Boolean);

  for (const id of mappedIds) {
    if (byId.has(id)) continue;
    // Try known slug from previous snapshot to build URL.
    const prev = prevById.get(id);
    const slug = prev?.slug || null;
    if (!slug) continue;
    const productUrl = `${BASE}/products/${slug}-${id}`;
    try {
      const html = await fetchText(productUrl);
      const state = parseNuxtState(html);
      const raw = state?.pages?.products?.singleProductForProductPage;
      if (raw && raw.id) {
        const normalized = normalizeApiProduct(raw);
        if (normalized) byId.set(normalized.handle, normalized);
      }
    } catch (_) {
      // Product gone — will be drafted.
    }
  }

  try {
    fs.mkdirSync(path.dirname(CATEGORY_INDEX_PATH), { recursive: true });
    fs.writeFileSync(CATEGORY_INDEX_PATH, JSON.stringify({
      scraped_at: new Date().toISOString(),
      source: BASE,
      categories: categoryResults
    }, null, 2), 'utf8');
  } catch (_) {
    // best-effort
  }

  const products = [...byId.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en'));
  return { products, categoryResults };
}

async function main() {
  const { products, categoryResults } = await fetchAllProducts();

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

  console.log(`UBazar: saved ${products.length} products -> ${OUT}`);
  console.log(`UBazar delta: +${delta.added.length} ~${delta.updated.length} -${delta.removed.length} -> ${OUT_DELTA}`);
}

module.exports = { fetchAllProducts, normalizeApiProduct, parseNuxtState };

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}
