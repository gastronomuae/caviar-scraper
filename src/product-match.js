const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PATHS = {
  supplier: path.join(ROOT, 'Output/products_all.json'),
  supplierLatest: path.join(ROOT, 'Output/products_all.latest.json'),
  shopifyPrimary: path.join(ROOT, 'Output/from_gastronom.json'),
  shopifyFallback: path.join(ROOT, 'Output/shopify_from_gastronom.json'),
  mapping: path.join(ROOT, 'data/product_mapping.json'),
  state: path.join(ROOT, 'data/match_review_state.json'),
  reportCsv: path.join(ROOT, 'Output/matching_report.csv')
};

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function extractHandleFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

function stripAed(priceStr) {
  if (priceStr == null) return null;
  const s = String(priceStr).replace(/\s*AED\s*$/i, '').replace(/,/g, '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** First variant numeric weight (grams) */
function supplierVariantWeight(product) {
  const v = (product.variants && product.variants[0]) || {};
  const w = v.weight;
  if (w == null) return null;
  const n = parseInt(String(w).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseShopifyWeight(raw) {
  if (raw == null) return null;
  const n = parseInt(String(raw).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseShopifyPrice(p) {
  if (p == null) return null;
  const n = Number(String(p).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Keep supplier rows where pathname / name / description match category.
 * Excludes hostname (e.g. 1-caviar.ae would otherwise match everything).
 *
 * Strict (default): word caviar or seafood (EN).
 * Broad: set env PRODUCT_MATCH_BROAD=1 to also match common seafood / RU икра / морепродукт.
 */
function filterSupplierCaviarSeafood(products) {
  const broad = process.env.PRODUCT_MATCH_BROAD === '1';
  const strictRe = /\b(caviar|seafood)\b/i;
  const broadRe =
    /\b(caviar|seafood|shrimp|crab|scallop|lobster|roe|sturgeon|trout|salmon|sockeye|herring|mackerel|nelma|omul|vobla|smelt|coho|nerka|keta|fish)\b|икра|морепродукт|креветк|краб|осетр|лосос|нерка|сёмг|форел/i;
  const re = broad ? broadRe : strictRe;
  const needle = (s) => re.test(s || '');
  return products.filter((p) => {
    let pathQuery = '';
    try {
      const u = new URL(p.url);
      pathQuery = `${u.pathname} ${u.search}`;
    } catch (_) {
      pathQuery = p.url || '';
    }
    const textBlob = `${p.name} ${p.description}`;
    return needle(textBlob) || needle(pathQuery);
  });
}

/**
 * Rows from products_all used to decide if a Gastronom product is "linked" for {@link getUnpairedGastronomProducts}.
 * Default: same caviar/seafood subset as the main report. Set env UNPAIRED_GASTRONOM_FULL_SUPPLIER=1 to use every
 * supplier row (legacy: match any handle / mapping on the full catalog).
 */
function supplierScopeForUnpairedGastronom(supplierArr) {
  if (process.env.UNPAIRED_GASTRONOM_FULL_SUPPLIER === '1') return supplierArr;
  return filterSupplierCaviarSeafood(supplierArr);
}

function normalizeSupplier(product) {
  const handle = extractHandleFromUrl(product.url);
  const v0 = (product.variants && product.variants[0]) || {};
  return {
    handle,
    name_en: product.name || '',
    description_en: product.description || '',
    image: product.image || null,
    price: stripAed(product.promotional_price),
    weight: supplierVariantWeight(product),
    raw: product
  };
}

function normalizeShopifyList(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((p) => {
    const v = (p.variants && p.variants[0]) || {};
    const id = p.shopify_product_id || p.id || null;
    const status = String((p && p['Product Status']) || '').trim() || '—';
    return {
      handle: p.handle || '',
      shopify_product_id: id,
      name_ru: p.name || p.title || '',
      description_ru: p.description || '',
      price: parseShopifyPrice(v.price != null ? v.price : p.price),
      weight: parseShopifyWeight(v.weight),
      image: (p['Image url'] || p.image || '').trim() || null,
      product_status: status,
      raw: p
    };
  });
}

function loadShopifyNormalized() {
  let data = loadJson(PATHS.shopifyPrimary);
  if (!data || !Array.isArray(data) || data.length === 0) {
    data = loadJson(PATHS.shopifyFallback);
  }
  return normalizeShopifyList(data || []);
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardTokens(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const u = A.size + B.size - inter;
  return u === 0 ? 0 : inter / u;
}

function bigramSimilarity(s, t) {
  const norm = (str) => String(str || '').toLowerCase().replace(/\s+/g, '');
  const a = norm(s);
  const b = norm(t);
  if (a.length < 2 || b.length < 2) return 0;
  const map = {};
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    map[bg] = (map[bg] || 0) + 1;
  }
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    if (map[bg] > 0) {
      inter++;
      map[bg]--;
    }
  }
  const denom = a.length - 1 + b.length - 1 - inter;
  return denom <= 0 ? 0 : inter / denom;
}

function nameSimilarityScore(nameEn, nameRu) {
  const t1 = tokenize(nameEn);
  const t2 = tokenize(nameRu);
  const joined1 = t1.join(' ');
  const joined2 = t2.join(' ');
  const j = jaccardTokens(t1, t2);
  const b = bigramSimilarity(joined1, joined2);
  return Math.round(100 * (0.55 * j + 0.45 * b));
}

function descriptionSimilarityScore(descEn, descRu) {
  if (!descEn || !descRu) return 0;
  const t1 = tokenize(descEn);
  const t2 = tokenize(descRu);
  if (t1.length < 3 || t2.length < 3) return 0;
  return Math.round(100 * jaccardTokens(t1, t2));
}

function combinedSuggestionScore(sup, shop) {
  const ns = nameSimilarityScore(sup.name_en, shop.name_ru);
  const ds = descriptionSimilarityScore(sup.description_en, shop.description_ru);
  if (!sup.description_en || !shop.description_ru) return ns;
  return Math.round(0.65 * ns + 0.35 * ds);
}

function shopifyByHandle(shopifyList) {
  const m = new Map();
  for (const s of shopifyList) {
    if (s.handle) m.set(s.handle, s);
  }
  return m;
}

function topSuggestions(supplierNorm, shopifyList, excludeHandleSet, limit = 3) {
  const scored = shopifyList
    .filter((s) => !excludeHandleSet?.has(s.handle))
    .map((s) => ({
      ...s,
      score: combinedSuggestionScore(supplierNorm, s)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

function loadMapping() {
  const j = loadJson(PATHS.mapping);
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

function loadState() {
  const j = loadJson(PATHS.state);
  return {
    noMatchHandles: Array.isArray(j?.noMatchHandles) ? j.noMatchHandles : [],
    manualNotes: (j && j.manualNotes) || {}
  };
}

function saveMapping(obj) {
  fs.mkdirSync(path.dirname(PATHS.mapping), { recursive: true });
  fs.writeFileSync(PATHS.mapping, JSON.stringify(obj, null, 2), 'utf8');
}

function saveState(state) {
  fs.mkdirSync(path.dirname(PATHS.state), { recursive: true });
  fs.writeFileSync(PATHS.state, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Detect corrupted mapping where many in-scope supplier handles share one GID (e.g. bad bulk edit).
 */
function auditInScopeMapping(supplierNorm, mapping) {
  /** @type {Map<string, string[]>} */
  const byGid = new Map();
  for (const s of supplierNorm) {
    const h = s.handle;
    if (!h) continue;
    const gid = mapping[h];
    if (!gid) continue;
    if (!byGid.has(gid)) byGid.set(gid, []);
    byGid.get(gid).push(h);
  }
  const duplicateGroups = [];
  let mappedHandleCount = 0;
  for (const [gid, handles] of byGid) {
    mappedHandleCount += handles.length;
    if (handles.length > 1) duplicateGroups.push({ shopify_product_id: gid, handles });
  }
  const uniqueGids = byGid.size;
  const warning_all_same_gid = uniqueGids === 1 && mappedHandleCount >= 2;
  return {
    mapped_handle_count: mappedHandleCount,
    unique_mapped_gid_count: uniqueGids,
    duplicate_gid_groups: duplicateGroups,
    warning_all_same_gid
  };
}

/**
 * Build full matching report rows for supplier + shopify.
 */
function buildMatchingReport() {
  const supplierRaw = loadJson(PATHS.supplier);
  const supplierArr = Array.isArray(supplierRaw) ? supplierRaw : [];
  const filtered = filterSupplierCaviarSeafood(supplierArr);
  const supplierNorm = filtered.map(normalizeSupplier).filter((s) => s.handle);

  const shopify = loadShopifyNormalized();
  const byHandle = shopifyByHandle(shopify);
  const mapping = loadMapping();
  const state = loadState();
  const noSet = new Set(state.noMatchHandles);

  const rows = [];

  for (const s of supplierNorm) {
    const exact = s.handle && byHandle.get(s.handle);
    const confirmedGid = mapping[s.handle];

    let status = '⚠️ needs review';
    let primaryScore = 0;

    const suggestions = [];

    if (confirmedGid) {
      status = '✅ confirmed';
      const shop =
        shopify.find((x) => x.shopify_product_id === confirmedGid) ||
        shopify.find((x) => x.handle === s.handle) ||
        null;
      if (shop) {
        suggestions.push({ ...shop, score: 100, reason: 'saved_mapping' });
      }
      const rest = topSuggestions(s, shopify, new Set([shop?.handle].filter(Boolean)), 2);
      for (const e of rest) suggestions.push({ ...e, reason: 'similarity' });
    } else if (noSet.has(s.handle)) {
      status = '❌ no match';
    } else if (exact) {
      status = '✅ matched (auto by handle)';
      primaryScore = 100;
      suggestions.push({ ...exact, score: 100, reason: 'exact_handle' });
      const extra = topSuggestions(s, shopify, new Set([exact.handle]), 2);
      for (const e of extra) suggestions.push({ ...e, reason: 'similarity' });
    } else {
      const top = topSuggestions(s, shopify, null, 3);
      primaryScore = top[0]?.score || 0;
      for (const t of top) suggestions.push({ ...t, reason: 'similarity' });
    }

    while (suggestions.length < 3) {
      suggestions.push(null);
    }

    rows.push({
      supplier: s,
      suggestions: suggestions.slice(0, 3),
      status,
      primaryScore
    });
  }

  const mappingAudit = auditInScopeMapping(supplierNorm, mapping);

  return { rows, shopify, supplierCount: supplierNorm.length, mappingAudit };
}

function rowToCsvLine(cells) {
  return cells
    .map((c) => {
      const s = c == null ? '' : String(c);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    })
    .join(',');
}

function writeMatchingReportCsv() {
  const { rows } = buildMatchingReport();
  const header = rowToCsvLine([
    'Supplier Name',
    'Gastronom Suggestion 1',
    'Score 1',
    'Gastronom Suggestion 2',
    'Score 2',
    'Gastronom Suggestion 3',
    'Score 3',
    'Status',
    'Action'
  ]);
  const lines = [header];
  for (const r of rows) {
    const s1 = r.suggestions[0];
    const s2 = r.suggestions[1];
    const s3 = r.suggestions[2];
    lines.push(
      rowToCsvLine([
        r.supplier.name_en,
        s1 ? s1.name_ru : '',
        s1 ? s1.score : '',
        s2 ? s2.name_ru : '',
        s2 ? s2.score : '',
        s3 ? s3.name_ru : '',
        s3 ? s3.score : '',
        r.status,
        ''
      ])
    );
  }
  fs.writeFileSync(PATHS.reportCsv, lines.join('\n'), 'utf8');
  return PATHS.reportCsv;
}

function finalReport() {
  const { rows } = buildMatchingReport();
  const mapping = loadMapping();
  const state = loadState();
  const noSet = new Set(state.noMatchHandles);

  const confirmed = [];
  const newProducts = [];
  const unmatched = [];

  for (const r of rows) {
    const h = r.supplier.handle;
    const gid = mapping[h];
    if (gid) {
      const sid = r.suggestions.find((s) => s && s.shopify_product_id === gid);
      confirmed.push({
        supplier: r.supplier.name_en,
        handle: h,
        gastronom: sid?.name_ru || '',
        shopify_product_id: gid
      });
    } else if (noSet.has(h)) {
      newProducts.push({ supplier: r.supplier.name_en, handle: h });
    } else {
      unmatched.push({
        supplier: r.supplier.name_en,
        handle: h,
        status: r.status,
        topSuggestion: r.suggestions[0]?.name_ru || null,
        topScore: r.suggestions[0]?.score ?? null
      });
    }
  }

  return { confirmed, newProducts, unmatched, mapping };
}

/**
 * Gastronom export (from_gastronom.json) rows not linked to in-scope supplier rows
 * (same filter as buildMatchingReport: caviar/seafood): no mapping GID from those
 * handles and no shared handle with that subset.
 */
function getUnpairedGastronomProducts() {
  const supplierRaw = loadJson(PATHS.supplier);
  const supplierArr = Array.isArray(supplierRaw) ? supplierRaw : [];
  const supplierForUnpaired = supplierScopeForUnpairedGastronom(supplierArr);
  const supplierHandles = new Set(
    supplierForUnpaired.map((p) => extractHandleFromUrl(p.url)).filter(Boolean)
  );

  const mapping = loadMapping();
  const mappedGidsFromOurSuppliers = new Set();
  for (const [h, gid] of Object.entries(mapping)) {
    if (supplierHandles.has(h) && gid) mappedGidsFromOurSuppliers.add(gid);
  }

  const shopify = loadShopifyNormalized();
  const products = [];
  for (const row of shopify) {
    const g = row.shopify_product_id;
    const h = row.handle;
    if (!g) continue;
    const byMapping = mappedGidsFromOurSuppliers.has(g);
    const bySharedHandle = h && supplierHandles.has(h);
    if (byMapping || bySharedHandle) continue;

    const raw = row.raw || {};
    const status = String(raw['Product Status'] || '').trim() || '—';
    products.push({
      handle: h,
      name: row.name_ru,
      image: row.image || null,
      status,
      shopify_product_id: g
    });
  }

  const statusOrder = (s) => {
    const u = String(s || '').trim().toUpperCase();
    if (u === 'ACTIVE') return 0;
    if (u === 'DRAFT') return 1;
    return 2;
  };
  products.sort((a, b) => {
    const d = statusOrder(a.status) - statusOrder(b.status);
    if (d !== 0) return d;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
  });

  const active = products.filter((p) => String(p.status || '').trim().toUpperCase() === 'ACTIVE').length;
  const draft = products.filter((p) => String(p.status || '').trim().toUpperCase() === 'DRAFT').length;
  const scope =
    process.env.UNPAIRED_GASTRONOM_FULL_SUPPLIER === '1' ? 'full_products_all' : 'caviar_seafood';
  return {
    count: products.length,
    active,
    draft,
    supplier_product_count: supplierForUnpaired.length,
    unpaired_gastronom_scope: scope,
    products
  };
}

/**
 * In-scope supplier (products_all) rows not linked to current Gastronom export (from_gastronom):
 * no shared handle and no saved mapping to a GID that appears in the export.
 */
function getUnpairedSupplierProducts() {
  const supplierRaw = loadJson(PATHS.supplier);
  const supplierArr = Array.isArray(supplierRaw) ? supplierRaw : [];
  const supplierFiltered = filterSupplierCaviarSeafood(supplierArr);
  const shopify = loadShopifyNormalized();
  const gastronomGids = new Set(shopify.map((s) => s.shopify_product_id).filter(Boolean));
  const gastronomHandles = new Set(shopify.map((s) => s.handle).filter(Boolean));
  const mapping = loadMapping();

  const products = [];
  for (const p of supplierFiltered) {
    const h = extractHandleFromUrl(p.url);
    if (!h) continue;
    const gid = mapping[h];
    const byHandle = gastronomHandles.has(h);
    const byMapping = Boolean(gid && gastronomGids.has(gid));
    if (byHandle || byMapping) continue;

    const rawUrl = String(p.url || '').trim();
    const url = rawUrl ? rawUrl.split('?')[0] : '';
    products.push({
      handle: h,
      name: p.name || '',
      image: p.image || null,
      url: url || rawUrl,
      price: stripAed(p.promotional_price)
    });
  }

  products.sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' })
  );

  return {
    count: products.length,
    supplier_product_count: supplierFiltered.length,
    products
  };
}

module.exports = {
  PATHS,
  loadJson,
  filterSupplierCaviarSeafood,
  normalizeSupplier,
  normalizeShopifyList,
  loadShopifyNormalized,
  buildMatchingReport,
  writeMatchingReportCsv,
  finalReport,
  loadMapping,
  loadState,
  saveMapping,
  saveState,
  nameSimilarityScore,
  combinedSuggestionScore,
  getUnpairedGastronomProducts,
  getUnpairedSupplierProducts,
  auditInScopeMapping
};
