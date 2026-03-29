/* Default broad supplier filter (caviar + seafood + common seafood terms). Set PRODUCT_MATCH_BROAD=0 for strict caviar|seafood only. */
if (process.env.PRODUCT_MATCH_BROAD === undefined) {
  process.env.PRODUCT_MATCH_BROAD = '1';
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');

/**
 * cPanel/Passenger mode: serve a tiny UI + run the cron CLI script from a browser.
 * Enable by setting CPANEL_AUTOMATION_UI=1 and AUTOMATION_KEY.
 */
const CPANEL_AUTOMATION_UI = process.env.CPANEL_AUTOMATION_UI === '1';

// Same credentials as `node scripts/verify-draft-mutation.js`: load scripts/shopify-test/.env
// when SHOP / CLIENT_* are not already set in the environment (e.g. plain `npm run review`).
(function loadOptionalShopifyTestEnv() {
  const envPath = path.join(__dirname, '..', 'scripts', 'shopify-test', '.env');
  if (!fs.existsSync(envPath)) return;
  let applied = 0;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    const k = m[1];
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied++;
    }
  }
  if (applied) {
    console.log('Loaded env from scripts/shopify-test/.env (only variables that were unset).');
  }
})();

// In CPANEL_AUTOMATION_UI mode we keep dependencies minimal and only run the CLI script.
let getAccessToken,
  getLocationIdByName,
  setAvailableQuantity,
  setVariantInventoryPolicy,
  setProductStatus,
  shopifyGraphql,
  executeVariantSyncFromSupplier,
  buildMatchingReport,
  writeMatchingReportCsv,
  finalReport,
  loadMapping,
  loadState,
  saveMapping,
  saveState,
  loadShopifyNormalized,
  normalizeShopifyList,
  getUnpairedGastronomProducts,
  getUnpairedSupplierProducts,
  PATHS,
  normalizeToGastronomFileShape,
  runSyncGastronomFromShopify,
  runDailyAutomation,
  createFileLock;

if (!CPANEL_AUTOMATION_UI) {
  ({
    getAccessToken,
    getLocationIdByName,
    setAvailableQuantity,
    setVariantInventoryPolicy,
    setProductStatus,
    graphql: shopifyGraphql
  } = require('./shopify-inventory'));
  ({ executeVariantSyncFromSupplier } = require('./shopify-variant-sync'));
  ({
    buildMatchingReport,
    writeMatchingReportCsv,
    finalReport,
    loadMapping,
    loadState,
    saveMapping,
    saveState,
    loadShopifyNormalized,
    normalizeShopifyList,
    getUnpairedGastronomProducts,
    getUnpairedSupplierProducts,
    PATHS
  } = require('./product-match'));
  ({
    normalizeToGastronomFileShape,
    runSyncGastronomFromShopify
  } = require('./sync-shopify-gastronom'));
  ({ runDailyAutomation, createFileLock } = require('./automation-runner'));
}

const app = express();
/** @type {Promise<unknown> | null} */
let gastronomSyncInFlight = null;
/** @type {Promise<unknown> | null} */
let dailyAutomationInFlight = null;
/** @type {any | null} */
let dailyAutomationLock = null;
let deployInFlight = false;

const AUTOMATION_LAST_JSON = path.join(__dirname, '..', 'Output', 'automation_last_run.json');
const AUTOMATION_LAST_TXT = path.join(__dirname, '..', 'Output', 'automation_last_run.txt');
const AUTOMATION_HISTORY_DIR = path.join(__dirname, '..', 'Output', 'automation_history');
const AUTOMATION_HISTORY_INDEX = path.join(AUTOMATION_HISTORY_DIR, 'index.json');
const SUPPLIER_DELTA_HISTORY_PATH = path.join(__dirname, '..', 'Output', 'supplier_delta_history', 'history.json');
const UBAZAR_LATEST_JSON = path.join(__dirname, '..', 'Output', 'ubazar_products.latest.json');
const UBAZAR_DELTA_JSON = path.join(__dirname, '..', 'Output', 'ubazar_delta.latest.json');
const UBAZAR_MATCH_JSON = path.join(__dirname, '..', 'Output', 'ubazar_match_report.latest.json');
const UBAZAR_MAPPING_JSON = path.join(__dirname, '..', 'data', 'ubazar_product_mapping.json');
const UBAZAR_STATE_JSON = path.join(__dirname, '..', 'Output', 'ubazar_match_state.json');
const GASTRONOM_UZBEK_LATEST_JSON = path.join(__dirname, '..', 'Output', 'gastronom_uzbek_fruits_veg.latest.json');
const UBAZAR_AUTOMATION_LAST_JSON = path.join(__dirname, '..', 'Output', 'ubazar_automation_last_run.json');
const UBAZAR_AUTOMATION_HISTORY_DIR = path.join(__dirname, '..', 'Output', 'ubazar_automation_history');
const UBAZAR_AUTOMATION_HISTORY_INDEX = path.join(UBAZAR_AUTOMATION_HISTORY_DIR, 'index.json');
const UBAZAR_SNAP_DIR = path.join(__dirname, '..', 'Output', 'snapshots', 'ubazar');

/** @type {Promise<unknown> | null} */
let ubazarAutomationInFlight = null;
/** @type {any | null} */
let ubazarAutomationLock = null;

function tokenizeSimple(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimple(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const u = A.size + B.size - inter;
  return u === 0 ? 0 : inter / u;
}

function scoreNameSimple(a, b) {
  return Math.round(100 * jaccardSimple(tokenizeSimple(a), tokenizeSimple(b)));
}

function loadUbazarLatest() {
  const j = readJsonSafe(UBAZAR_LATEST_JSON, []);
  return Array.isArray(j) ? j : [];
}

function readUbazarProductByHandle(handle) {
  const h = String(handle || '').trim();
  if (!h) return null;
  const arr = loadUbazarLatest();
  return arr.find((x) => String(x?.handle || '').trim() === h) || null;
}

function resolveShopifyProductGidByHandle(handle) {
  const h = String(handle || '').trim();
  if (!h) return null;
  const rows = loadShopifyNormalized();
  const row = rows.find((r) => String(r?.handle || '').trim() === h) || null;
  return row?.shopify_product_id ? String(row.shopify_product_id) : null;
}

async function resolveShopifyProductGidByHandleLive(handle) {
  const h = String(handle || '').trim();
  if (!h) return null;
  const token = await getAccessToken();
  const data = await shopifyGraphql(
    token,
    `query FindByHandle($q: String!) {
      products(first: 1, query: $q) {
        edges { node { id handle } }
      }
    }`,
    { q: `handle:${h}` }
  );
  const edge = data?.products?.edges?.[0] || null;
  const node = edge?.node || null;
  if (!node?.id) return null;
  if (String(node.handle || '').trim() !== h) return null;
  return String(node.id);
}

function ubazarPriceNumber(p) {
  const n = Number(p);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function executeSingleVariantSyncFromUbazar({ sourceHandle, gastronomHandle }) {
  const supplier = readUbazarProductByHandle(sourceHandle);
  if (!supplier) throw new Error(`No supplier row for handle: ${sourceHandle}`);
  let productGid = resolveShopifyProductGidByHandle(gastronomHandle);
  if (!productGid) productGid = await resolveShopifyProductGidByHandleLive(gastronomHandle);
  if (!productGid) throw new Error(`No Gastronom product for handle: ${gastronomHandle}`);

  const token = await getAccessToken();
  let locationId = SHOPIFY_LOCATION_ID;
  if (!locationId) {
    locationId = await getLocationIdByName(token, SHOPIFY_LOCATION_NAME);
  }

  const productData = await shopifyGraphql(
    token,
    `query OneProduct($id: ID!) {
      product(id: $id) {
        id
        status
        variants(first: 1) {
          edges {
            node {
              id
              price
              inventoryQuantity
              inventoryPolicy
            }
          }
        }
      }
    }`,
    { id: productGid }
  );
  const p = productData?.product;
  const v = p?.variants?.edges?.[0]?.node || null;
  if (!p?.id || !v?.id) throw new Error(`Target product has no variants: ${productGid}`);

  const updates = [{ id: v.id }];
  // When supplier has a promotional (sale) price: price = promo (what customer pays),
  // compareAtPrice = regular (original, shown crossed out). Standard Shopify sale display.
  // When no promotional price: price = regular price, compareAtPrice cleared.
  const promoPrice = ubazarPriceNumber(supplier.promotional_price);
  const regularPrice = ubazarPriceNumber(supplier.regular_price);
  const price = promoPrice ?? regularPrice;
  // Shopify Decimal fields must be strings.
  if (price != null && price > 0) updates[0].price = String(price);
  if (promoPrice != null && regularPrice != null && regularPrice !== promoPrice) {
    updates[0].compareAtPrice = String(regularPrice);
  } else {
    updates[0].compareAtPrice = null;
  }

  let inventoryPolicy = null;
  let quantity = null;
  if (supplier.available === false) {
    inventoryPolicy = 'DENY';
    quantity = 0;
  } else {
    inventoryPolicy = 'CONTINUE';
    quantity = 0;
  }
  if (inventoryPolicy) updates[0].inventoryPolicy = inventoryPolicy;

  const mutResult = await shopifyGraphql(
    token,
    `mutation PVBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price compareAtPrice inventoryPolicy }
        userErrors { field message }
      }
    }`,
    { productId: p.id, variants: updates }
  );
  const mutErrors = mutResult?.productVariantsBulkUpdate?.userErrors;
  if (Array.isArray(mutErrors) && mutErrors.length) {
    throw new Error(`productVariantsBulkUpdate userErrors: ${JSON.stringify(mutErrors)}`);
  }

  if (quantity != null) {
    await setAvailableQuantity({
      variantId: v.id,
      locationId,
      quantity,
      reason: 'correction',
      referenceDocumentUri: 'caviar-scraper://ubazar/single-variant-sync'
    });
  }

  let setActiveAfterSync = false;
  let statusNow = String(p.status || '').toUpperCase().trim();
  if (statusNow === 'DRAFT' && supplier.available === true) {
    const changed = await setProductStatus(p.id, 'ACTIVE');
    setActiveAfterSync = true;
    statusNow = String(changed?.status || statusNow).toUpperCase().trim();
  }

  // Fetch final state for immediate UI refresh.
  const afterData = await shopifyGraphql(
    token,
    `query After($id: ID!) {
      product(id: $id) {
        id
        status
        variants(first: 1) {
          edges {
            node { id price inventoryQuantity inventoryPolicy }
          }
        }
      }
    }`,
    { id: p.id }
  );
  const afterV = afterData?.product?.variants?.edges?.[0]?.node || null;

  return {
    ok: true,
    mode: 'ubazar_single_variant',
    source_handle: sourceHandle,
    gastronom_handle: gastronomHandle,
    shopify_product_id: p.id,
    applied: {
      bulk_update_rows: 1,
      inventory_rows: quantity != null ? 1 : 0,
      option_values_added: 0,
      reorder_moved_rows: 0
    },
    set_active_after_sync: setActiveAfterSync,
    after: {
      product_status: String(afterData?.product?.status || statusNow || '').toUpperCase().trim() || null,
      variant_id: afterV?.id || null,
      price: afterV?.price != null ? Number(afterV.price) : null,
      inventory_policy: afterV?.inventoryPolicy ? String(afterV.inventoryPolicy).toUpperCase().trim() : null,
      inventory_quantity: afterV?.inventoryQuantity != null ? Number(afterV.inventoryQuantity) : null
    }
  };
}

function loadGastronomUzbekLatest() {
  const j = readJsonSafe(path.join(__dirname, '..', 'Output', 'gastronom_uzbek_fruits_veg.latest.json'), {});
  const arr = Array.isArray(j?.products) ? j.products : [];
  return arr;
}

function loadGastronomImagesByHandle() {
  const rows = readJsonSafe(path.join(__dirname, '..', 'Output', 'from_gastronom.json'), []);
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const h = String(r?.handle || '').trim();
    if (!h) continue;
    const img =
      r?.image ||
      r?.image_url ||
      r?.imageUrl ||
      r?.['Image url'] ||
      r?.['image url'] ||
      null;
    if (img && !out.has(h)) out.set(h, String(img));
  }
  return out;
}

function loadUbazarMapping() {
  const j = readJsonSafe(UBAZAR_MAPPING_JSON, {});
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

function saveUbazarMapping(obj) {
  fs.mkdirSync(path.dirname(UBAZAR_MAPPING_JSON), { recursive: true });
  fs.writeFileSync(UBAZAR_MAPPING_JSON, JSON.stringify(obj, null, 2), 'utf8');
}

function loadUbazarState() {
  const j = readJsonSafe(UBAZAR_STATE_JSON, {});
  return {
    noMatchHandles: Array.isArray(j?.noMatchHandles) ? j.noMatchHandles : []
  };
}

function saveUbazarState(state) {
  fs.mkdirSync(path.dirname(UBAZAR_STATE_JSON), { recursive: true });
  fs.writeFileSync(UBAZAR_STATE_JSON, JSON.stringify(state, null, 2), 'utf8');
}

function buildUbazarMatchReport() {
  const supplier = loadUbazarLatest();
  const gastronom = loadGastronomUzbekLatest();
  const gastronomImages = loadGastronomImagesByHandle();
  const mapping = loadUbazarMapping();
  const state = loadUbazarState();
  const noSet = new Set(state.noMatchHandles);

  const rows = [];
  for (const s of supplier) {
    const handle = String(s?.handle || '').trim();
    if (!handle) continue;
    const mappedHandle = String(mapping[handle] || '').trim();

    const scored = gastronom
      .map((g) => ({
        ...g,
        // Keep same field names as main matcher UI.
        name_ru: g.name,
        shopify_product_id: g.handle,
        image: g?.image || gastronomImages.get(String(g?.handle || '').trim()) || null,
        score: scoreNameSimple(s.name, g.name),
        reason: 'name_similarity'
      }))
      .sort((a, b) => b.score - a.score);

    // IMPORTANT: for confirmed mappings, force the mapped product to appear first.
    let suggestions = scored.slice(0, 3);
    if (mappedHandle) {
      const mapped = scored.find((x) => String(x?.handle || '').trim() === mappedHandle) || null;
      if (mapped) {
        suggestions = [
          {
            ...mapped,
            score: 100,
            reason: 'saved_mapping'
          },
          ...scored.filter((x) => String(x?.handle || '').trim() !== mappedHandle).slice(0, 2)
        ];
      }
    }
    let status = '⚠️ needs review';
    if (mappedHandle) status = '✅ confirmed';
    else if (noSet.has(handle)) status = '❌ no match';
    rows.push({
      supplier: {
        ...s,
        name_en: s.name
      },
      status,
      mapped_handle: mappedHandle || null,
      suggestions
    });
  }
  rows.sort((a, b) => String(a.supplier?.name || '').localeCompare(String(b.supplier?.name || ''), 'ru'));
  return { rows, gastronom_count: gastronom.length, supplier_count: rows.length };
}

function loadGastronomUzbekProducts() {
  const j = readJsonSafe(GASTRONOM_UZBEK_LATEST_JSON, {});
  const arr = Array.isArray(j?.products) ? j.products : [];
  return arr;
}

app.get('/api/ubazar/unpaired-gastronom', (req, res) => {
  try {
    const gastronom = loadGastronomUzbekProducts();
    const mapping = loadUbazarMapping();
    const mappedTargets = new Set(Object.values(mapping || {}).map((x) => String(x || '').trim()).filter(Boolean));
    const unpaired = gastronom.filter((g) => {
      const h = String(g?.handle || '').trim();
      if (!h) return false;
      return !mappedTargets.has(h);
    });
    const active = unpaired.filter((p) => String(p?.product_status || '').toUpperCase().trim() === 'ACTIVE').length;
    const draft = unpaired.filter((p) => String(p?.product_status || '').toUpperCase().trim() === 'DRAFT').length;
    res.json({
      ok: true,
      supplier: 'ubazar',
      gastronom_source: 'uzbek_collection',
      gastronom_count: gastronom.length,
      count: unpaired.length,
      active,
      draft,
      products: unpaired.map((p) => ({
        name: p.name,
        handle: p.handle,
        image: p.image || null,
        url: p.url || null,
        status: String(p.product_status || '').toUpperCase().trim() || '—'
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** UBazar: draft all ACTIVE unpaired Gastronom products (same UX as caviar modal). */
app.post('/api/ubazar/unpaired-gastronom/draft-active', async (req, res) => {
  try {
    const mapping = loadUbazarMapping();
    const mappedTargets = new Set(Object.values(mapping || {}).map((x) => String(x || '').trim()).filter(Boolean));
    const gastronom = loadGastronomUzbekProducts();
    const targets = gastronom
      .filter((p) => {
        const h = String(p?.handle || '').trim();
        if (!h) return false;
        if (mappedTargets.has(h)) return false;
        return String(p?.product_status || '').toUpperCase().trim() === 'ACTIVE';
      })
      .map((p) => String(p.handle).trim());

    const drafted = [];
    const failed = [];
    for (const handle of targets) {
      try {
        const gid = await resolveShopifyProductGidByHandleLive(handle);
        if (!gid) throw new Error(`No Shopify product found by handle: ${handle}`);
        await setProductStatus(gid, 'DRAFT');
        drafted.push(handle);
      } catch (e) {
        failed.push({ handle, error: String(e.message || e) });
      }
    }
    res.json({ ok: true, drafted: drafted.length, failed, handles: drafted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/unpaired-supplier', (req, res) => {
  try {
    const supplier = loadUbazarLatest();
    const mapping = loadUbazarMapping();
    const state = loadUbazarState();
    const noMatch = new Set((state?.noMatchHandles || []).map((x) => String(x || '').trim()).filter(Boolean));
    const products = supplier.filter((s) => {
      const h = String(s?.handle || '').trim();
      if (!h) return false;
      const mapped = String(mapping?.[h] || '').trim();
      if (mapped) return false;
      return true;
    });
    const noMatchCount = products.filter((p) => noMatch.has(String(p?.handle || '').trim())).length;
    const needsReviewCount = Math.max(0, products.length - noMatchCount);
    res.json({
      ok: true,
      supplier: 'ubazar',
      supplier_product_count: supplier.length,
      count: products.length,
      counts: { needs_review: needsReviewCount, no_match: noMatchCount },
      products: products.map((p) => ({
        name: p.name,
        handle: p.handle,
        image: p.image || null,
        url: p.url || null,
        price: p.promotional_price ?? p.regular_price ?? null,
        available: p.available ?? null,
        status: noMatch.has(String(p?.handle || '').trim()) ? 'NO MATCH' : 'NEEDS REVIEW'
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

function execNodeScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, ...args], { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${err.message}\n${String(stderr || stdout || '').slice(0, 800)}`;
        return reject(new Error(msg));
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function ensureOutputDir() {
  const outDir = path.join(__dirname, '..', 'Output');
  fs.mkdirSync(outDir, { recursive: true });
}

function toRunId(iso) {
  const s = String(iso || new Date().toISOString());
  return s.replace(/[:.]/g, '-');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeAutomationArtifacts(result) {
  ensureOutputDir();
  fs.writeFileSync(AUTOMATION_LAST_JSON, JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(AUTOMATION_LAST_TXT, buildAutomationTextLog(result), 'utf8');

  fs.mkdirSync(AUTOMATION_HISTORY_DIR, { recursive: true });
  const runId = toRunId(result?.started_at);
  const runFile = `${runId}.json`;
  const runPath = path.join(AUTOMATION_HISTORY_DIR, runFile);
  fs.writeFileSync(runPath, JSON.stringify(result, null, 2), 'utf8');

  let index = readJsonSafe(AUTOMATION_HISTORY_INDEX, []);
  if (!Array.isArray(index)) index = [];
  index = index.filter((x) => x && x.id !== runId);
  index.unshift({
    id: runId,
    started_at: result?.started_at || null,
    finished_at: result?.finished_at || null,
    ok: result?.ok === true,
    counts: result?.counts || {},
    file: runFile
  });
  index = index.slice(0, 60);
  fs.writeFileSync(AUTOMATION_HISTORY_INDEX, JSON.stringify(index, null, 2), 'utf8');

  return {
    run_id: runId,
    json: path.basename(AUTOMATION_LAST_JSON),
    txt: path.basename(AUTOMATION_LAST_TXT),
    history_json: runFile
  };
}

function writeUbazarAutomationArtifacts(result) {
  fs.mkdirSync(UBAZAR_AUTOMATION_HISTORY_DIR, { recursive: true });
  fs.writeFileSync(UBAZAR_AUTOMATION_LAST_JSON, JSON.stringify(result, null, 2), 'utf8');
  const runId = toRunId(result?.started_at);
  const runFile = `${runId}.json`;
  const runPath = path.join(UBAZAR_AUTOMATION_HISTORY_DIR, runFile);
  fs.writeFileSync(runPath, JSON.stringify(result, null, 2), 'utf8');
  let index = readJsonSafe(UBAZAR_AUTOMATION_HISTORY_INDEX, []);
  if (!Array.isArray(index)) index = [];
  index = index.filter((x) => x && x.id !== runId);
  index.unshift({
    id: runId,
    started_at: result?.started_at || null,
    finished_at: result?.finished_at || null,
    ok: result?.ok === true,
    counts: result?.counts || {},
    file: runFile
  });
  index = index.slice(0, 60);
  fs.writeFileSync(UBAZAR_AUTOMATION_HISTORY_INDEX, JSON.stringify(index, null, 2), 'utf8');
  return { run_id: runId, history_json: runFile };
}

function ubazarSupplierKey(p) {
  return String(p?.handle || '').trim() || null;
}

function ubazarSupplierComparable(p) {
  return {
    name: p?.name ?? '',
    url: p?.url ?? '',
    image: p?.image ?? null,
    regular_price: p?.regular_price ?? null,
    promotional_price: p?.promotional_price ?? null,
    available: p?.available == null ? null : Boolean(p?.available)
  };
}

function diffUbazarSnapshots(prevArr, nextArr) {
  const prevMap = new Map();
  const nextMap = new Map();
  for (const p of prevArr || []) { const k = ubazarSupplierKey(p); if (k) prevMap.set(k, p); }
  for (const p of nextArr || []) { const k = ubazarSupplierKey(p); if (k) nextMap.set(k, p); }
  const added = [], removed = [], updated = [];
  for (const [k, p] of nextMap) {
    if (!prevMap.has(k)) { added.push({ handle: k, name: p?.name ?? '', url: p?.url ?? '', image: p?.image ?? null }); continue; }
    const a = ubazarSupplierComparable(prevMap.get(k));
    const b = ubazarSupplierComparable(p);
    const changed = [];
    if (JSON.stringify(a.promotional_price) !== JSON.stringify(b.promotional_price)) changed.push({ field: 'promotional_price', from: a.promotional_price, to: b.promotional_price });
    if (JSON.stringify(a.regular_price) !== JSON.stringify(b.regular_price)) changed.push({ field: 'regular_price', from: a.regular_price, to: b.regular_price });
    if (JSON.stringify(a.available) !== JSON.stringify(b.available)) changed.push({ field: 'available', from: a.available, to: b.available });
    if (changed.length) updated.push({ handle: k, name: b.name || a.name || '', url: b.url || a.url || '', changed });
  }
  for (const [k, p] of prevMap) {
    if (!nextMap.has(k)) removed.push({ handle: k, name: p?.name ?? '', url: p?.url ?? '', image: p?.image ?? null });
  }
  return { added, removed, updated };
}

function saveUbazarSnapshot() {
  fs.mkdirSync(UBAZAR_SNAP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(UBAZAR_SNAP_DIR, `${stamp}.json`);
  const arr = readJsonSafe(UBAZAR_LATEST_JSON, []);
  fs.writeFileSync(outPath, JSON.stringify(Array.isArray(arr) ? arr : [], null, 2), 'utf8');
  return { saved: path.basename(outPath), count: Array.isArray(arr) ? arr.length : 0 };
}

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? String(x) : '0';
}

function buildAutomationTextLog(run) {
  const lines = [];
  const findStep = (name) =>
    (Array.isArray(run?.steps) ? run.steps : []).find((s) => s && s.step === name) || null;
  const supplierDelta = findStep('supplier_delta');
  const syncStep = findStep('variant_sync_mapped_updates');
  const syncItems = Array.isArray(syncStep?.ok_items) ? syncStep.ok_items : [];
  const totalVariantRowsUpdated = syncItems.reduce((sum, it) => sum + Number(it?.applied?.bulk_update_rows || 0), 0);
  const totalInventoryRowsUpdated = syncItems.reduce((sum, it) => sum + Number(it?.applied?.inventory_rows || 0), 0);
  lines.push(`Automation run`);
  lines.push(`Started: ${run.started_at || '—'}`);
  lines.push(`Finished: ${run.finished_at || '—'}`);
  lines.push(`Result: ${run.ok ? 'OK' : 'FAILED'}`);
  lines.push('');

  const c = run.counts || {};
  lines.push(`Summary`);
  lines.push(`- Supplier catalog now has ${fmt(c.supplier_latest_products)} products in total.`);
  lines.push(
    `- Supplier changes vs previous snapshot: ${fmt(supplierDelta?.counts?.added)} added, ${fmt(
      supplierDelta?.counts?.updated
    )} updated, ${fmt(supplierDelta?.counts?.removed)} removed.`
  );
  lines.push(
    `- Unpaired Shopify products moved ACTIVE -> DRAFT: ${fmt(c.drafted_unpaired_active)} (failed ${fmt(c.drafted_failures)}).`
  );
  lines.push(
    `- Mapped products synced to Shopify: ${fmt(syncStep?.ok_count)} successful out of ${fmt(syncStep?.targets)} target products (failed ${fmt(
      syncStep?.failed_count
    )}, skipped ${fmt(syncStep?.skipped_count)}).`
  );
  lines.push(
    `- Total variant rows updated: ${fmt(totalVariantRowsUpdated)} price/variant updates and ${fmt(
      totalInventoryRowsUpdated
    )} inventory updates.`
  );
  lines.push('');

  const steps = Array.isArray(run.steps) ? run.steps : [];
  lines.push(`Steps`);
  for (const s of steps) {
    const name = s?.step || 'unknown';
    const ok = s?.ok === true ? 'OK' : 'FAIL';
    lines.push(`- ${name}: ${ok}`);
    if (s?.error) lines.push(`  error: ${String(s.error).slice(0, 500)}`);
    if (name === 'sync_gastronom' && s?.ok) {
      lines.push(`  shop: ${s.shop || '—'} vendor: ${s.vendor || '—'} products: ${fmt(s.products)}`);
      if (s.delta_counts) {
        lines.push(
          `  delta: +${fmt(s.delta_counts.added)} ~${fmt(s.delta_counts.updated)} -${fmt(s.delta_counts.removed)}`
        );
      }
    }
    if (name === 'supplier_snapshot' && s?.ok) {
      lines.push(`  saved: ${s.saved || '—'} count: ${fmt(s.count)}`);
    }
    if (name === 'supplier_delta' && s?.ok && s?.counts) {
      lines.push(`  delta: +${fmt(s.counts.added)} ~${fmt(s.counts.updated)} -${fmt(s.counts.removed)}`);
    }
    if (name === 'draft_unpaired_active' && s) {
      lines.push(`  eligible_active: ${fmt(s.eligible_active)} drafted: ${fmt(s.drafted)} failed: ${fmt((s.failed || []).length)}`);
      const failed = Array.isArray(s.failed) ? s.failed : [];
      for (const f of failed.slice(0, 10)) {
        lines.push(`  - failed ${f.handle || ''} ${f.shopify_product_id || ''}: ${String(f.error || '').slice(0, 200)}`);
      }
      if (failed.length > 10) lines.push(`  - … ${failed.length - 10} more failures`);
    }
    if (name === 'variant_sync_mapped_updates' && s) {
      lines.push(
        `  targets: ${fmt(s.targets)} ok: ${fmt(s.ok_count)} failed: ${fmt(s.failed_count)} skipped: ${fmt(s.skipped_count)}`
      );
      const failed = Array.isArray(s.failed) ? s.failed : [];
      for (const f of failed.slice(0, 10)) {
        lines.push(
          `  - failed ${f.source_handle || ''} ${f.shopify_product_id || ''}: ${String(f.error || '').slice(0, 200)}`
        );
      }
      if (failed.length > 10) lines.push(`  - … ${failed.length - 10} more failures`);
      const skipped = Array.isArray(s.skipped) ? s.skipped : [];
      for (const sk of skipped.slice(0, 10)) {
        lines.push(`  - skipped ${sk.source_handle || ''}: ${String(sk.reason || '').slice(0, 200)}`);
      }
      if (skipped.length > 10) lines.push(`  - … ${skipped.length - 10} more skipped`);
    }
  }

  const errs = Array.isArray(run.errors) ? run.errors : [];
  if (errs.length) {
    lines.push('');
    lines.push('Errors');
    for (const e of errs) lines.push(`- ${String(e).slice(0, 800)}`);
  }
  const warns = Array.isArray(run.warnings) ? run.warnings : [];
  if (warns.length) {
    lines.push('');
    lines.push('Warnings');
    for (const w of warns) lines.push(`- ${String(w).slice(0, 800)}`);
  }
  lines.push('');
  return lines.join('\n');
}
// cPanel Passenger uses PORT. Keep REVIEW_PORT for local dev compatibility.
const PORT = Number(process.env.PORT || process.env.REVIEW_PORT || 3001);
const PUBLIC = path.join(__dirname, '../public');
const SNAP_DIR = path.join(__dirname, '../Output/snapshots/supplier');
const SUPPLIER_LATEST =
  (PATHS && PATHS.supplierLatest) || path.join(__dirname, '../Output/products_all.latest.json');
const SHOPIFY_LOCATION_NAME = (process.env.SHOPIFY_LOCATION_NAME || 'Al Quoz Industrial Area 4').trim();
const SHOPIFY_LOCATION_ID = (process.env.SHOPIFY_LOCATION_ID || '').trim();

app.use(express.json());

// -------------------------
// Minimal cPanel automation UI
// -------------------------
if (CPANEL_AUTOMATION_UI) {
  const KEY = String(process.env.AUTOMATION_KEY || '').trim();
  let running = false;
  let deploying = false;

  function checkKey(req) {
    const q = String(req.query.key || '').trim();
    const h = String(req.headers['x-automation-key'] || '').trim();
    const provided = q || h;
    if (!KEY) return { ok: false, reason: 'Missing server env AUTOMATION_KEY' };
    if (!provided || provided !== KEY) return { ok: false, reason: 'Forbidden' };
    return { ok: true };
  }

  app.get('/', (req, res) => {
    const k = checkKey(req);
    if (!k.ok) return res.status(403).type('text').send(k.reason);
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Caviar Automation</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}
  button{padding:10px 16px;border-radius:8px;border:1px solid #ccc;cursor:pointer}
  pre{white-space:pre-wrap;background:#111827;color:#e5e7eb;padding:12px;border-radius:8px;overflow:auto}
  .muted{color:#6b7280}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}
  code{background:#f3f4f6;padding:2px 6px;border-radius:6px}
</style>
</head>
<body>
  <h1>Caviar Automation</h1>
  <div class="muted">Protected endpoint. Uses <code>?key=...</code> or header <code>x-automation-key</code>.</div>
  <div class="row">
    <button id="run">Run Automation</button>
    <span id="status" class="muted"></span>
  </div>
  <pre id="out">Ready.</pre>
<script>
  const key = new URLSearchParams(location.search).get('key') || '';
  const btn = document.getElementById('run');
  const out = document.getElementById('out');
  const st = document.getElementById('status');
  btn.onclick = async () => {
    btn.disabled = true; st.textContent = 'Running…'; out.textContent = '';
    try{
      const res = await fetch('/run?key=' + encodeURIComponent(key), { method:'POST' });
      const txt = await res.text();
      out.textContent = txt;
      st.textContent = res.ok ? 'Done' : 'Failed';
    }catch(e){
      out.textContent = String(e);
      st.textContent = 'Failed';
    }finally{
      btn.disabled = false;
    }
  };
</script>
</body></html>`);
  });

  app.post('/run', async (req, res) => {
    const k = checkKey(req);
    if (!k.ok) return res.status(403).type('text').send(k.reason);
    if (running) return res.status(409).type('text').send('Already running');
    running = true;
    const started = new Date();
    console.log(`[automation] start ${started.toISOString()}`);
    try {
      const script = path.join(__dirname, '..', 'scripts', 'run-automation-cli.js');
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        execFile(process.execPath, [script], { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
          if (err) return reject(Object.assign(err, { stdout, stderr }));
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      });
      const ended = new Date();
      console.log(`[automation] ok ${ended.toISOString()} elapsed_ms=${ended - started}`);
      res.type('text').send(
        [
          `Status: OK`,
          `Started: ${started.toISOString()}`,
          `Finished: ${ended.toISOString()}`,
          `Elapsed ms: ${ended - started}`,
          '',
          stdout,
          stderr ? `\n[stderr]\n${stderr}` : ''
        ].join('\n')
      );
    } catch (e) {
      const ended = new Date();
      console.log(`[automation] fail ${ended.toISOString()} elapsed_ms=${ended - started} err=${String(e.message || e)}`);
      const stderr = e && e.stderr ? String(e.stderr) : '';
      const stdout = e && e.stdout ? String(e.stdout) : '';
      res.status(500).type('text').send(
        [
          `Status: FAIL`,
          `Started: ${started.toISOString()}`,
          `Finished: ${ended.toISOString()}`,
          `Elapsed ms: ${ended - started}`,
          '',
          String(e.message || e),
          stdout ? `\n[stdout]\n${stdout}` : '',
          stderr ? `\n[stderr]\n${stderr}` : ''
        ].join('\n')
      );
    } finally {
      running = false;
    }
  });

  app.post('/deploy', (req, res) => {
    const k = checkKey(req);
    if (!k.ok) return res.status(403).type('text').send(k.reason);
    if (deploying) return res.status(409).type('text').send('Already deploying');
    deploying = true;
    const started = new Date();
    console.log(`[deploy] start ${started.toISOString()}`);
    execFile('bash', [path.join(__dirname, '..', 'scripts', 'deploy.sh')], { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
      const ended = new Date();
      if (err) {
        console.error(err);
        console.log(`[deploy] fail ${ended.toISOString()} elapsed_ms=${ended - started}`);
        deploying = false;
        return res.status(500).type('text').send(`Deploy failed\n\n${String(stderr || stdout || err.message || err)}`);
      }
      console.log(String(stdout || '').slice(0, 2000));
      console.log(`[deploy] ok ${ended.toISOString()} elapsed_ms=${ended - started}`);
      deploying = false;
      res.type('text').send(
        [`Deployed`, `Started: ${started.toISOString()}`, `Finished: ${ended.toISOString()}`, '', String(stdout || ''), stderr ? `\n[stderr]\n${stderr}` : ''].join(
          '\n'
        )
      );
    });
  });
}

// If running in cPanel mode, don't register the full review UI/API.
if (CPANEL_AUTOMATION_UI) {
  const server = app.listen(PORT, () => {
    console.log(`Caviar Automation UI: listening on port ${PORT}`);
  });
  server.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
  return;
}

// Deploy endpoint for normal review mode (so GitHub webhook works when full UI is enabled).
app.all(['/deploy', '/deploy/'], (req, res) => {
  const key = String(process.env.AUTOMATION_KEY || '').trim();
  const provided = String(req.query.key || req.headers['x-automation-key'] || '').trim();
  if (!key) return res.status(403).type('text').send('Missing server env AUTOMATION_KEY');
  if (!provided || provided !== key) return res.status(403).type('text').send('Forbidden');
  if (deployInFlight) return res.status(409).type('text').send('Already deploying');

  deployInFlight = true;
  const started = new Date();
  console.log(`[deploy-hit] method=${req.method} url=${req.originalUrl}`);
  console.log(`[deploy] start ${started.toISOString()}`);
  execFile('bash', [path.join(__dirname, '..', 'scripts', 'deploy.sh')], { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
    const ended = new Date();
    deployInFlight = false;
    if (err) {
      console.error(err);
      console.log(`[deploy] fail ${ended.toISOString()} elapsed_ms=${ended - started}`);
      return res.status(500).type('text').send(`Deploy failed\n\n${String(stderr || stdout || err.message || err)}`);
    }
    console.log(String(stdout || '').slice(0, 2000));
    console.log(`[deploy] ok ${ended.toISOString()} elapsed_ms=${ended - started}`);
    return res.type('text').send(
      [
        'Deployed',
        `Started: ${started.toISOString()}`,
        `Finished: ${ended.toISOString()}`,
        '',
        String(stdout || ''),
        stderr ? `\n[stderr]\n${stderr}` : ''
      ].join('\n')
    );
  });
});

function ensureFiles() {
  if (!fs.existsSync(PATHS.mapping)) {
    fs.mkdirSync(path.dirname(PATHS.mapping), { recursive: true });
    fs.writeFileSync(PATHS.mapping, '{}\n', 'utf8');
  }
  if (!fs.existsSync(PATHS.state)) {
    saveState({ noMatchHandles: [], manualNotes: {} });
  }
  fs.mkdirSync(SNAP_DIR, { recursive: true });
}

function extractHandleFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

function readSupplierFile(p) {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function listSnapshots() {
  if (!fs.existsSync(SNAP_DIR)) return [];
  const files = fs
    .readdirSync(SNAP_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => {
      const full = path.join(SNAP_DIR, f);
      const st = fs.statSync(full);
      return { file: f, full, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function saveSupplierSnapshot() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(SNAP_DIR, `${stamp}.json`);
  const arr = readSupplierFile(PATHS.supplier);
  fs.writeFileSync(outPath, JSON.stringify(arr, null, 2), 'utf8');

  // Keep only last 2 snapshots
  const snaps = listSnapshots();
  for (const s of snaps.slice(2)) {
    try {
      fs.unlinkSync(s.full);
    } catch (_) {
      // ignore
    }
  }
  return { saved: path.basename(outPath), count: arr.length };
}

function publishLatestSupplier() {
  if (!fs.existsSync(SUPPLIER_LATEST)) {
    throw new Error(`Missing latest supplier file: ${SUPPLIER_LATEST}`);
  }
  const latestArr = readSupplierFile(SUPPLIER_LATEST);
  fs.mkdirSync(path.dirname(PATHS.supplier), { recursive: true });
  fs.copyFileSync(SUPPLIER_LATEST, PATHS.supplier);
  return { published: true, count: latestArr.length };
}

function supplierKey(p) {
  const h = extractHandleFromUrl(p?.url) || p?.handle || null;
  return h ? String(h).trim() : null;
}

function supplierComparable(p) {
  const v = Array.isArray(p?.variants) ? p.variants : [];
  return {
    name: p?.name ?? '',
    url: p?.url ?? '',
    image: p?.image ?? null,
    promotional_price: p?.promotional_price ?? null,
    regular_price: p?.regular_price ?? null,
    variants: v.map((x) => ({
      variant_id: x?.variant_id ?? null,
      weight: x?.weight ?? null,
      promotional_price: x?.promotional_price ?? null,
      regular_price: x?.regular_price ?? null,
      qty: x?.qty ?? null,
      unlimited_stock: Boolean(x?.unlimited_stock),
      limited_stock: Boolean(x?.limited_stock),
      out_of_stock: Boolean(x?.out_of_stock),
      available: x?.available == null ? null : Boolean(x?.available)
    }))
  };
}

function readSupplierProductByHandle(handle) {
  const h = String(handle || '').trim();
  if (!h) return null;
  const arr = readSupplierFile(PATHS.supplier);
  for (const p of arr) {
    const ph = extractHandleFromUrl(p?.url) || p?.handle;
    if (ph && String(ph).trim() === h) return p;
  }
  return null;
}

function readSupplierProductByHandleFromFile(filePath, handle) {
  const h = String(handle || '').trim();
  if (!h) return null;
  const arr = readSupplierFile(filePath);
  for (const p of arr) {
    const ph = extractHandleFromUrl(p?.url) || p?.handle;
    if (ph && String(ph).trim() === h) return p;
  }
  return null;
}

function matchStatusForHandle(handle) {
  const h = String(handle || '').trim();
  if (!h) return '—';
  const mapping = loadMapping();
  const state = loadState();
  const noSet = new Set(state?.noMatchHandles || []);
  if (noSet.has(h)) return '❌ no match';
  if (mapping && mapping[h]) return '✅ confirmed';
  // best-effort: if Gastronom has same handle, treat as auto by handle
  try {
    const shop = loadShopifyNormalized();
    const has = shop.some((x) => x && String(x.handle || '').trim() === h);
    if (has) return '✅ matched (auto by handle)';
  } catch (_) {
    // ignore
  }
  return '⚠️ needs review';
}

function diffSupplierSnapshots(prevArr, nextArr) {
  const prevMap = new Map();
  const nextMap = new Map();

  for (const p of prevArr || []) {
    const k = supplierKey(p);
    if (!k) continue;
    prevMap.set(k, p);
  }
  for (const p of nextArr || []) {
    const k = supplierKey(p);
    if (!k) continue;
    nextMap.set(k, p);
  }

  const added = [];
  const removed = [];
  const updated = [];

  for (const [k, p] of nextMap) {
    if (!prevMap.has(k)) {
      added.push({
        handle: k,
        name: p?.name ?? '',
        url: p?.url ?? '',
        image: p?.image ?? null,
        match_status: matchStatusForHandle(k)
      });
      continue;
    }
    const a = supplierComparable(prevMap.get(k));
    const b = supplierComparable(p);
    const changed = [];
    const pushIf = (field, av, bv) => {
      if (JSON.stringify(av) !== JSON.stringify(bv)) changed.push({ field, from: av, to: bv });
    };
    pushIf('promotional_price', a.promotional_price, b.promotional_price);
    pushIf('regular_price', a.regular_price, b.regular_price);
    pushIf('variants', a.variants, b.variants);
    if (changed.length) {
      updated.push({
        handle: k,
        name: b.name || a.name || '',
        url: b.url || a.url || '',
        image: b.image ?? a.image ?? null,
        match_status: matchStatusForHandle(k),
        changed
      });
    }
  }
  for (const [k, p] of prevMap) {
    if (!nextMap.has(k))
      removed.push({
        handle: k,
        name: p?.name ?? '',
        url: p?.url ?? '',
        image: p?.image ?? null,
        match_status: matchStatusForHandle(k)
      });
  }

  added.sort((x, y) => String(x.name).localeCompare(String(y.name), 'en', { sensitivity: 'base' }));
  removed.sort((x, y) => String(x.name).localeCompare(String(y.name), 'en', { sensitivity: 'base' }));
  updated.sort((x, y) => String(x.name).localeCompare(String(y.name), 'en', { sensitivity: 'base' }));

  return { added, removed, updated };
}

app.get('/api/report', (req, res) => {
  try {
    const data = buildMatchingReport();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/api/report.csv', (req, res) => {
  try {
    const out = writeMatchingReportCsv();
    res.download(out, 'matching_report.csv');
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/api/final-report', (req, res) => {
  try {
    res.json(finalReport());
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

/** Pull Gastronom catalog from Shopify (same as `npm run sync:gastronom`). Requires review server + Shopify env. */
app.post('/api/sync-gastronom', async (req, res) => {
  if (gastronomSyncInFlight) {
    return res.status(409).json({ ok: false, error: 'Gastronom sync already running; wait for it to finish.' });
  }
  gastronomSyncInFlight = runSyncGastronomFromShopify().finally(() => {
    gastronomSyncInFlight = null;
  });
  try {
    const result = await gastronomSyncInFlight;
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Daily automation (single button):
 * 1) Sync Gastronom from Shopify
 * 2) Supplier scan -> latest; save snapshot; compute delta; publish latest to dashboard
 * 3) Draft all ACTIVE unpaired Gastronom products
 * 4) For each supplier-delta "updated" handle that has mapping and exists in Gastronom export -> sync variants
 */
app.post('/api/automation/run', async (req, res) => {
  if (dailyAutomationInFlight) {
    return res.status(409).json({ ok: false, error: 'Automation already running; wait for it to finish.' });
  }

  // Cross-process lock (Passenger can have multiple Node instances).
  try {
    dailyAutomationLock = createFileLock(path.join(__dirname, '..', 'Output', 'locks', 'automation.lock'));
  } catch (e) {
    return res.status(409).json({ ok: false, error: String(e.message || e) });
  }

  const supplierLatestPath = SUPPLIER_LATEST;
  const snapshotDir = SNAP_DIR;
  const loc = SHOPIFY_LOCATION_ID || SHOPIFY_LOCATION_NAME;

  dailyAutomationInFlight = runDailyAutomation({
    lockPath: null, // locked by review-server (so we can keep the inFlight in-process semantics too)
    supplierLatestPath,
    snapshotDir,
    shopifyLocationNameOrId: loc
  })
    .then((result) => {
      try {
        result.report_paths = writeAutomationArtifacts(result);
      } catch (e) {
        result.warnings = result.warnings || [];
        result.warnings.push(`Could not write automation report files: ${String(e.message || e)}`);
      }
      return result;
    })
    .finally(() => {
      dailyAutomationInFlight = null;
      if (dailyAutomationLock) {
        dailyAutomationLock.release();
        dailyAutomationLock = null;
      }
    });

  try {
    const out = await dailyAutomationInFlight;
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/automation/last-run', (req, res) => {
  try {
    if (!fs.existsSync(AUTOMATION_LAST_JSON)) return res.status(404).json({ ok: false, error: 'No automation run saved yet.' });
    res.type('json').send(fs.readFileSync(AUTOMATION_LAST_JSON, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/automation/last-run.txt', (req, res) => {
  try {
    if (!fs.existsSync(AUTOMATION_LAST_TXT)) return res.status(404).type('text').send('No automation run saved yet.');
    res.type('text').send(fs.readFileSync(AUTOMATION_LAST_TXT, 'utf8'));
  } catch (e) {
    res.status(500).type('text').send(String(e.message || e));
  }
});

app.get('/api/automation/history', (req, res) => {
  try {
    const max = Number(req.query.limit || 30);
    const limit = Number.isFinite(max) && max > 0 ? max : 30;
    const index = readJsonSafe(AUTOMATION_HISTORY_INDEX, []);
    const entries = Array.isArray(index) ? index.slice(0, limit) : [];
    res.json({ ok: true, entries });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/automation/history/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const runPath = path.join(AUTOMATION_HISTORY_DIR, `${id}.json`);
    if (!fs.existsSync(runPath)) return res.status(404).json({ ok: false, error: 'Run not found' });
    res.type('json').send(fs.readFileSync(runPath, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Supplier delta history (added/updated/removed) over time. */
app.get('/api/supplier-delta/history', (req, res) => {
  try {
    const max = Number(req.query.limit || 14);
    const limit = Number.isFinite(max) && max > 0 ? max : 14;
    if (!fs.existsSync(SUPPLIER_DELTA_HISTORY_PATH)) return res.json({ ok: true, entries: [] });
    const raw = fs.readFileSync(SUPPLIER_DELTA_HISTORY_PATH, 'utf8');
    let history = [];
    try {
      history = JSON.parse(raw);
    } catch (_) {
      history = [];
    }
    if (!Array.isArray(history)) history = [];
    res.json({ ok: true, entries: history.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/ubazar/run', async (req, res) => {
  if (ubazarAutomationInFlight) {
    return res.status(409).json({ ok: false, error: 'UBazar automation already running; wait for it to finish.' });
  }
  try {
    ubazarAutomationLock = createFileLock(path.join(__dirname, '..', 'Output', 'locks', 'ubazar_automation.lock'));
  } catch (e) {
    return res.status(409).json({ ok: false, error: String(e.message || e) });
  }

  const started_at = new Date().toISOString();
  const result = {
    ok: true,
    started_at,
    finished_at: null,
    steps: [],
    warnings: [],
    errors: [],
    counts: {
      ubazar_latest_products: 0,
      supplier_delta_added: 0,
      supplier_delta_removed: 0,
      supplier_delta_updated: 0,
      drafted_unpaired_gastronom: 0,
      drafted_unpaired_failed: 0,
      mapped_activated: 0,
      mapped_drafted: 0,
      mapped_failed: 0,
      variant_sync_ok: 0,
      variant_sync_failed: 0
    }
  };

  ubazarAutomationInFlight = (async () => {
    try {
      // Step 1: fetch Gastronom collection (before changes)
      const m0 = await execNodeScript(path.join(__dirname, '..', 'src', 'fetch-gastronom-uzbek-fruits-veg.js'));
      result.steps.push({ step: 'fetch_gastronom_uzbek', ok: true, ...m0 });

      // Step 2: snapshot previous UBazar state (for delta)
      const ubazarBefore = readJsonSafe(UBAZAR_LATEST_JSON, []);
      const snap = saveUbazarSnapshot();
      result.steps.push({ step: 'ubazar_snapshot_before', ok: true, ...snap });

      // Step 3: scrape UBazar
      const r = await execNodeScript(path.join(__dirname, '..', 'src', 'fetch-products-all-ubazar.js'));
      result.steps.push({ step: 'ubazar_scrape', ok: true, ...r });

      // Step 4: compute supplier delta
      const ubazarAfter = readJsonSafe(UBAZAR_LATEST_JSON, []);
      result.counts.ubazar_latest_products = Array.isArray(ubazarAfter) ? ubazarAfter.length : 0;
      const delta = diffUbazarSnapshots(Array.isArray(ubazarBefore) ? ubazarBefore : [], Array.isArray(ubazarAfter) ? ubazarAfter : []);
      result.counts.supplier_delta_added = delta.added.length;
      result.counts.supplier_delta_removed = delta.removed.length;
      result.counts.supplier_delta_updated = delta.updated.length;
      result.steps.push({ step: 'supplier_delta', ok: true, counts: { added: delta.added.length, removed: delta.removed.length, updated: delta.updated.length }, delta });

      // Step 5: draft UNPAIRED Gastronom products (not mapped to any UBazar item)
      const mapping = loadUbazarMapping();
      const mappedTargets = new Set(Object.values(mapping || {}).map((x) => String(x || '').trim()).filter(Boolean));
      const gastronom = loadGastronomUzbekProducts();
      const unpairedHandles = gastronom
        .map((p) => String(p?.handle || '').trim())
        .filter(Boolean)
        .filter((h) => !mappedTargets.has(h));

      const drafted = [];
      const draftFailed = [];
      for (const gastroHandle of unpairedHandles) {
        try {
          const gid = await resolveShopifyProductGidByHandleLive(gastroHandle);
          if (!gid) throw new Error(`No Shopify product found by handle: ${gastroHandle}`);
          await setProductStatus(gid, 'DRAFT');
          drafted.push({ gastronom_handle: gastroHandle });
        } catch (e) {
          draftFailed.push({ gastronom_handle: gastroHandle, error: String(e.message || e) });
        }
      }
      result.counts.drafted_unpaired_gastronom = drafted.length;
      result.counts.drafted_unpaired_failed = draftFailed.length;
      result.steps.push({ step: 'draft_unpaired_gastronom', ok: draftFailed.length === 0, drafted, failed: draftFailed });

      // Step 6: for each mapped pair — ACTIVE+sync if UBazar present & available, else DRAFT
      const ubazarByHandle = new Map((Array.isArray(ubazarAfter) ? ubazarAfter : []).map((x) => [String(x?.handle || '').trim(), x]));
      const activatedMapped = [];
      const draftedMapped = [];
      const mappedFailed = [];
      const mappedSynced = [];
      const mappedSyncFailed = [];
      // Track activated gastronom handles to prevent old slug-based mapping keys from
      // overriding (drafting) a product that was just activated via its numeric key.
      const alreadyActivatedHandles = new Set();
      for (const [sourceHandle, gastroHandleRaw] of Object.entries(mapping || {})) {
        const source = String(sourceHandle || '').trim();
        const gastroHandle = String(gastroHandleRaw || '').trim();
        if (!source || !gastroHandle) continue;
        let sup = ubazarByHandle.get(source) || null;
        // If the mapping key is an old slug (e.g. "eggplant-500g-1670"), extract the
        // trailing numeric ID and fall back to looking up by that.
        if (!sup) {
          const trailingNum = source.match(/-(\d+)$/)?.[1];
          if (trailingNum) sup = ubazarByHandle.get(trailingNum) || null;
        }
        const shouldDraft = !sup || sup.available === false;
        // Skip drafting if this gastronom product was already activated in this run.
        // This handles the case where both a numeric key ("2038") and an old slug key
        // ("tomatoes-pink-paradise-500g-143") exist in the mapping for the same product.
        if (shouldDraft && alreadyActivatedHandles.has(gastroHandle)) continue;
        try {
          const gid = await resolveShopifyProductGidByHandleLive(gastroHandle);
          if (!gid) throw new Error(`No Shopify product found by handle: ${gastroHandle}`);
          if (shouldDraft) {
            await setProductStatus(gid, 'DRAFT');
            draftedMapped.push({ source_handle: source, gastronom_handle: gastroHandle, reason: !sup ? 'missing_from_ubazar' : 'ubazar_unavailable' });
          } else {
            await setProductStatus(gid, 'ACTIVE');
            alreadyActivatedHandles.add(gastroHandle);
            activatedMapped.push({ source_handle: source, gastronom_handle: gastroHandle });
            try {
              const out = await executeSingleVariantSyncFromUbazar({ sourceHandle: source, gastronomHandle: gastroHandle });
              mappedSynced.push({ source_handle: source, gastronom_handle: gastroHandle, after: out?.after || null });
            } catch (se) {
              mappedSyncFailed.push({ source_handle: source, gastronom_handle: gastroHandle, error: String(se.message || se) });
            }
          }
        } catch (e) {
          mappedFailed.push({ source_handle: source, gastronom_handle: gastroHandle, error: String(e.message || e) });
        }
      }
      result.counts.mapped_activated = activatedMapped.length;
      result.counts.mapped_drafted = draftedMapped.length;
      result.counts.mapped_failed = mappedFailed.length;
      result.counts.variant_sync_ok = mappedSynced.length;
      result.counts.variant_sync_failed = mappedSyncFailed.length;
      result.steps.push({
        step: 'sync_mapped_products',
        ok: mappedFailed.length === 0 && mappedSyncFailed.length === 0,
        activated: activatedMapped,
        drafted: draftedMapped,
        failed: mappedFailed,
        synced: mappedSynced,
        sync_failed: mappedSyncFailed
      });

      // Step 7: re-fetch Gastronom snapshot so UI shows updated ACTIVE/DRAFT state
      const m1 = await execNodeScript(path.join(__dirname, '..', 'src', 'fetch-gastronom-uzbek-fruits-veg.js'));
      result.steps.push({ step: 'fetch_gastronom_uzbek_post_sync', ok: true, ...m1 });

      result.finished_at = new Date().toISOString();
    } catch (e) {
      result.ok = false;
      result.errors.push(String(e.message || e));
      result.finished_at = new Date().toISOString();
    }

    try {
      result.report_paths = writeUbazarAutomationArtifacts(result);
    } catch (e) {
      result.warnings.push(`Could not write ubazar automation report files: ${String(e.message || e)}`);
    }
    return result;
  })().finally(() => {
    ubazarAutomationInFlight = null;
    if (ubazarAutomationLock) {
      ubazarAutomationLock.release();
      ubazarAutomationLock = null;
    }
  });

  try {
    const out = await ubazarAutomationInFlight;
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/automation/last-run', (req, res) => {
  try {
    if (!fs.existsSync(UBAZAR_AUTOMATION_LAST_JSON)) return res.status(404).json({ ok: false, error: 'No UBazar automation run saved yet.' });
    res.type('json').send(fs.readFileSync(UBAZAR_AUTOMATION_LAST_JSON, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/automation/history', (req, res) => {
  try {
    const max = Number(req.query.limit || 30);
    const limit = Number.isFinite(max) && max > 0 ? max : 30;
    const index = readJsonSafe(UBAZAR_AUTOMATION_HISTORY_INDEX, []);
    const entries = Array.isArray(index) ? index.slice(0, limit) : [];
    res.json({ ok: true, entries });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/automation/history/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const runPath = path.join(UBAZAR_AUTOMATION_HISTORY_DIR, `${id}.json`);
    if (!fs.existsSync(runPath)) return res.status(404).json({ ok: false, error: 'Run not found' });
    res.type('json').send(fs.readFileSync(runPath, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/latest', (req, res) => {
  try {
    if (!fs.existsSync(UBAZAR_LATEST_JSON)) return res.status(404).json({ ok: false, error: 'No UBazar latest file yet.' });
    res.type('json').send(fs.readFileSync(UBAZAR_LATEST_JSON, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/delta', (req, res) => {
  try {
    if (!fs.existsSync(UBAZAR_DELTA_JSON)) return res.status(404).json({ ok: false, error: 'No UBazar delta file yet.' });
    res.type('json').send(fs.readFileSync(UBAZAR_DELTA_JSON, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/match-report', (req, res) => {
  try {
    if (!fs.existsSync(UBAZAR_MATCH_JSON)) return res.status(404).json({ ok: false, error: 'No UBazar match report yet.' });
    res.type('json').send(fs.readFileSync(UBAZAR_MATCH_JSON, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/gastronom-uzbek/run', async (req, res) => {
  try {
    const m = await execNodeScript(path.join(__dirname, '..', 'src', 'fetch-gastronom-uzbek-fruits-veg.js'));
    res.json({ ok: true, gastronom_latest_path: GASTRONOM_UZBEK_LATEST_JSON, gastronom_run: m });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/gastronom-uzbek/latest', (req, res) => {
  try {
    if (!fs.existsSync(GASTRONOM_UZBEK_LATEST_JSON)) {
      return res.status(404).json({ ok: false, error: 'No Gastronom Uzbek latest file yet.' });
    }
    res.type('json').send(fs.readFileSync(GASTRONOM_UZBEK_LATEST_JSON, 'utf8'));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Public Shopify storefront suggest search (no admin token), used by UBazar manual search.
app.get('/api/gastronom/public-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const url =
      'https://www.gastronom.ae/search/suggest.json' +
      `?q=${encodeURIComponent(q)}` +
      '&resources[type]=product' +
      '&resources[limit]=20' +
      '&resources[options][unavailable_products]=last';
    const { data } = await axios.get(url, {
      timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
    });
    const products = data?.resources?.results?.products || [];
    const hits = (Array.isArray(products) ? products : []).map((p) => ({
      name: p?.title || '',
      name_ru: p?.title || '',
      handle: p?.handle || null,
      // In UBazar flow we treat handle as the stable identifier; sync resolves to GID live.
      shopify_product_id: p?.handle || null,
      image: p?.image || null,
      available: p?.available ?? null,
      url: p?.url ? `https://www.gastronom.ae${p.url}` : p?.handle ? `https://www.gastronom.ae/products/${p.handle}` : null,
      price: p?.price ?? null
    }));
    res.json(hits.filter((h) => h.handle));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Collection-only search (Uzbek fruits/veg), used when you want to avoid unrelated store products.
app.get('/api/gastronom/uzbek-search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const products = loadGastronomUzbekProducts();
    const hits = products
      .filter((p) => {
        const name = String(p?.name || '').toLowerCase();
        const handle = String(p?.handle || '').toLowerCase();
        return name.includes(q) || handle.includes(q);
      })
      .slice(0, 30)
      .map((p) => ({
        name: p?.name || '',
        name_ru: p?.name || '',
        handle: p?.handle || null,
        shopify_product_id: p?.handle || null,
        image: p?.image || null,
        available: p?.available ?? null,
        url: p?.url || (p?.handle ? `https://www.gastronom.ae/products/${p.handle}` : null),
        price: p?.price ?? null,
        source: 'collection:fruits-vegetables-uzbekistan'
      }))
      .filter((h) => h.handle);
    res.json(hits);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/report', (req, res) => {
  try {
    res.json(buildUbazarMatchReport());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/ubazar/search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const gastronom = loadGastronomUzbekLatest();
    const gastronomImages = loadGastronomImagesByHandle();
    const hits = gastronom
      .filter((g) => String(g?.name || '').toLowerCase().includes(q) || String(g?.handle || '').toLowerCase().includes(q))
      .slice(0, 20)
      .map((g) => ({
        name: g.name,
        name_ru: g.name,
        handle: g.handle,
        shopify_product_id: g.handle,
        image: g?.image || gastronomImages.get(String(g?.handle || '').trim()) || null,
        url: g.url,
        price: g.price,
        available: g.available
      }));
    res.json(hits);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/ubazar/confirm', (req, res) => {
  try {
    const sourceHandle = String(req.body?.source_handle || '').trim();
    const gastronomHandle = String(
      req.body?.gastronom_handle || req.body?.shopify_product_id || ''
    ).trim();
    if (!sourceHandle || !gastronomHandle) {
      return res.status(400).json({ ok: false, error: 'source_handle and gastronom_handle required' });
    }
    const m = loadUbazarMapping();
    m[sourceHandle] = gastronomHandle;
    saveUbazarMapping(m);

    const st = loadUbazarState();
    st.noMatchHandles = (st.noMatchHandles || []).filter((h) => h !== sourceHandle);
    saveUbazarState(st);
    res.json({ ok: true, mapping: m });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/ubazar/no-match', (req, res) => {
  try {
    const sourceHandle = String(req.body?.source_handle || '').trim();
    if (!sourceHandle) return res.status(400).json({ ok: false, error: 'source_handle required' });
    const m = loadUbazarMapping();
    delete m[sourceHandle];
    saveUbazarMapping(m);

    const st = loadUbazarState();
    const set = new Set(st.noMatchHandles || []);
    set.add(sourceHandle);
    st.noMatchHandles = [...set];
    saveUbazarState(st);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Clear a wrong confirmed mapping (keeps row in "needs review", does NOT mark as "no match").
app.post('/api/ubazar/clear-match', (req, res) => {
  try {
    const sourceHandle = String(req.body?.source_handle || '').trim();
    if (!sourceHandle) return res.status(400).json({ ok: false, error: 'source_handle required' });
    const m = loadUbazarMapping();
    delete m[sourceHandle];
    saveUbazarMapping(m);

    const st = loadUbazarState();
    st.noMatchHandles = (st.noMatchHandles || []).filter((h) => h !== sourceHandle);
    saveUbazarState(st);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/confirm', (req, res) => {
  try {
    const { source_handle, shopify_product_id } = req.body || {};
    if (!source_handle || !shopify_product_id) {
      return res.status(400).json({ error: 'source_handle and shopify_product_id required' });
    }
    const mapping = loadMapping();
    mapping[source_handle] = shopify_product_id;
    saveMapping(mapping);

    const state = loadState();
    state.noMatchHandles = (state.noMatchHandles || []).filter((h) => h !== source_handle);
    saveState(state);

    res.json({ ok: true, mapping });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/no-match', (req, res) => {
  try {
    const { source_handle } = req.body || {};
    if (!source_handle) {
      return res.status(400).json({ error: 'source_handle required' });
    }
    const mapping = loadMapping();
    delete mapping[source_handle];
    saveMapping(mapping);

    const state = loadState();
    const set = new Set(state.noMatchHandles || []);
    set.add(source_handle);
    state.noMatchHandles = [...set];
    saveState(state);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/api/unpaired-gastronom', (req, res) => {
  try {
    res.json(getUnpairedGastronomProducts());
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

/** Set every ACTIVE product in the unpaired-Gastronom list to DRAFT in Shopify (same scope as /api/unpaired-gastronom). */
app.post('/api/unpaired-gastronom/draft-active', async (req, res) => {
  try {
    const { products, active } = getUnpairedGastronomProducts();
    const targets = (products || []).filter(
      (p) =>
        p?.shopify_product_id &&
        String(p.status || '')
          .trim()
          .toUpperCase() === 'ACTIVE'
    );
    const drafted = [];
    const failed = [];
    for (const p of targets) {
      try {
        await setProductStatus(p.shopify_product_id, 'DRAFT');
        drafted.push({ handle: p.handle, shopify_product_id: p.shopify_product_id });
      } catch (e) {
        failed.push({ handle: p.handle, shopify_product_id: p.shopify_product_id, error: String(e.message) });
      }
    }
    res.json({
      ok: true,
      eligible_active: targets.length,
      list_active_count: active,
      drafted: drafted.length,
      failed,
      drafted_handles: drafted.map((x) => x.handle)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.get('/api/unpaired-supplier', (req, res) => {
  try {
    res.json(getUnpairedSupplierProducts());
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/api/search', (req, res) => {
  try {
    const q = String(req.query.q || '')
      .toLowerCase()
      .trim();
    if (!q) return res.json([]);
    const shopify = loadShopifyNormalized();
    const hits = shopify.filter(
      (s) =>
        s.name_ru.toLowerCase().includes(q) ||
        s.handle.toLowerCase().includes(q) ||
        (s.description_ru && s.description_ru.toLowerCase().includes(q))
    );
    res.json(hits.slice(0, 30));
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

/** Quick diagnostics for one supplier handle (helps verify what this server instance is using right now). */
app.get('/api/debug/handle', (req, res) => {
  try {
    const handle = String(req.query.handle || '').trim();
    if (!handle) {
      return res.status(400).json({ ok: false, error: 'handle query required' });
    }

    const supplierStaged = readSupplierProductByHandleFromFile(PATHS.supplier, handle);
    const supplierLatest = readSupplierProductByHandleFromFile(SUPPLIER_LATEST, handle);
    const mapping = loadMapping();
    const mappedGid = mapping[handle] || null;
    const shopifyRows = loadShopifyNormalized();
    const byMappedGid = mappedGid ? shopifyRows.find((r) => r.shopify_product_id === mappedGid) || null : null;
    const bySameHandle = shopifyRows.find((r) => String(r.handle || '').trim() === handle) || null;

    return res.json({
      ok: true,
      handle,
      files: {
        supplier_staged: PATHS.supplier,
        supplier_latest: SUPPLIER_LATEST
      },
      mapping: {
        mapped_gid: mappedGid
      },
      supplier: {
        staged: supplierStaged,
        latest: supplierLatest
      },
      shopify: {
        by_mapped_gid: byMappedGid,
        by_same_handle: bySameHandle
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/supplier-snapshot', (req, res) => {
  try {
    const saved = saveSupplierSnapshot();
    res.json({ ok: true, ...saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/** Run supplier scan (same as `npm run fetch:products-all`) and write Output/products_all.latest.json. */
app.post('/api/supplier-scan', async (req, res) => {
  try {
    const r = await execNodeScript(path.join(__dirname, 'fetch-products-all-1caviar.js'));
    const latestArr = readSupplierFile(SUPPLIER_LATEST);
    res.json({ ok: true, latest_count: latestArr.length, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/supplier-delta', (req, res) => {
  try {
    const staged = readSupplierFile(PATHS.supplier);
    const latest = readSupplierFile(SUPPLIER_LATEST);
    if (!Array.isArray(latest) || latest.length === 0) {
      return res.json({
        ok: false,
        message:
          'No latest supplier file found yet. Run the supplier scraper to create Output/products_all.latest.json, then reload.',
        staged_count: Array.isArray(staged) ? staged.length : 0,
        latest_path: SUPPLIER_LATEST
      });
    }
    const delta = diffSupplierSnapshots(Array.isArray(staged) ? staged : [], Array.isArray(latest) ? latest : []);
    res.json({
      ok: true,
      mode: 'staged_vs_latest',
      files: { staged: path.basename(PATHS.supplier), latest: path.basename(SUPPLIER_LATEST) },
      counts_source: { staged: staged.length, latest: latest.length },
      counts: { added: delta.added.length, removed: delta.removed.length, updated: delta.updated.length },
      delta
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.post('/api/supplier-publish', (req, res) => {
  try {
    const result = publishLatestSupplier();
    res.json({ ok: true, ...result, staged_path: PATHS.supplier, latest_path: SUPPLIER_LATEST });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.post('/api/inventory/set', async (req, res) => {
  try {
    const { variant_id, quantity } = req.body || {};
    if (!variant_id) return res.status(400).json({ ok: false, error: 'variant_id required' });
    if (quantity == null || String(quantity).trim() === '') {
      return res.status(400).json({ ok: false, error: 'quantity required' });
    }
    const n = Number(String(quantity).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return res.status(400).json({ ok: false, error: 'quantity must be an integer' });
    }
    if (n < 0) return res.status(400).json({ ok: false, error: 'quantity must be >= 0' });

    const token = await getAccessToken();
    const locationId = SHOPIFY_LOCATION_ID || (await getLocationIdByName(token, SHOPIFY_LOCATION_NAME));
    const vid = String(variant_id).trim();
    await setVariantInventoryPolicy({ variantId: vid, inventoryPolicy: 'DENY' });
    const group = await setAvailableQuantity({
      variantId: vid,
      locationId,
      quantity: n
    });
    res.json({
      ok: true,
      location_name: SHOPIFY_LOCATION_ID ? '(from SHOPIFY_LOCATION_ID)' : SHOPIFY_LOCATION_NAME,
      location_id: locationId,
      result: group
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.post('/api/inventory/policy', async (req, res) => {
  try {
    const { variant_id, inventory_policy } = req.body || {};
    if (!variant_id) return res.status(400).json({ ok: false, error: 'variant_id required' });
    const pol = String(inventory_policy || '').toUpperCase();
    if (pol !== 'CONTINUE' && pol !== 'DENY') {
      return res.status(400).json({ ok: false, error: 'inventory_policy must be CONTINUE or DENY' });
    }
    const pv = await setVariantInventoryPolicy({
      variantId: String(variant_id).trim(),
      inventoryPolicy: pol
    });
    res.json({ ok: true, productVariant: pv });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/**
 * Full variant alignment: prices, policies, qty from staged supplier JSON; add missing weights;
 * variants not on supplier → qty 0 + DENY. Requires Shopify scopes: write_products, write_inventory.
 */
app.post('/api/variants/sync-from-supplier', async (req, res) => {
  try {
    const { source_handle, shopify_product_id, dry_run, supplier_mode } = req.body || {};
    const mode = String(supplier_mode || 'caviar').trim().toLowerCase();
    if (mode === 'ubazar') {
      if (!source_handle || !shopify_product_id) {
        return res
          .status(400)
          .json({ ok: false, error: 'source_handle and shopify_product_id(gastronom handle) required' });
      }
      const result = await executeSingleVariantSyncFromUbazar({
        sourceHandle: String(source_handle).trim(),
        gastronomHandle: String(shopify_product_id).trim()
      });
      return res.json(result);
    }
    if (!source_handle || !shopify_product_id) {
      return res.status(400).json({ ok: false, error: 'source_handle and shopify_product_id required' });
    }
    const supplier = readSupplierProductByHandle(source_handle);
    if (!supplier) {
      return res.status(404).json({ ok: false, error: `No supplier row for handle: ${source_handle}` });
    }
    const loc = SHOPIFY_LOCATION_ID || SHOPIFY_LOCATION_NAME;
    const result = await executeVariantSyncFromSupplier(
      String(shopify_product_id).trim(),
      supplier,
      loc,
      { dryRun: Boolean(dry_run) }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/** One product from Shopify Admin, same shape as a Gastronom suggestion row (for live UI refresh after sync). */
async function fetchLiveGastronomNormalizedRow(productGid) {
  const token = await getAccessToken();
  const data = await shopifyGraphql(
    token,
    `query OneProd($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        vendor
        status
        productType
        description
        featuredImage { url }
        variants(first: 100) {
          edges {
            node {
              id
              title
              price
              sku
              barcode
              inventoryQuantity
              inventoryPolicy
            }
          }
        }
      }
    }`,
    { id: String(productGid).trim() }
  );
  const node = data?.product;
  if (!node) return null;
  const raw = normalizeToGastronomFileShape(node);
  return normalizeShopifyList([raw])[0] || null;
}

app.get('/api/gastronom-product-live', async (req, res) => {
  try {
    const gid = String(req.query.shopify_product_id || '').trim();
    if (!gid) return res.status(400).json({ ok: false, error: 'shopify_product_id query required' });
    const row = await fetchLiveGastronomNormalizedRow(gid);
    if (!row) return res.status(404).json({ ok: false, error: 'Product not found in Shopify' });
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/** So the UI's apiOrigin() talks to this process (not a stale server on :3001 when REVIEW_PORT differs). */
function sendReviewHtml(res) {
  const htmlPath = path.join(PUBLIC, 'review.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/const REVIEW_PORT = '3001';/, `const REVIEW_PORT = '${PORT}';`);
  res.type('html').send(html);
}

app.get('/', (req, res, next) => {
  const forceMode = process.env.UBAZAR_REDIRECT_MODE;
  if (forceMode && !req.query.mode) {
    return res.redirect(`/?mode=${encodeURIComponent(forceMode)}`);
  }
  next();
}, (req, res) => sendReviewHtml(res));
app.get('/review.html', (req, res) => sendReviewHtml(res));

app.use(express.static(PUBLIC));

app.get('/supplier-delta', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'supplier-delta.html'));
});

app.get('/automation-report', (req, res) => {
  const forceMode = process.env.UBAZAR_REDIRECT_MODE;
  if (forceMode && !req.query.mode) {
    return res.redirect(`/automation-report?mode=${encodeURIComponent(forceMode)}`);
  }
  res.sendFile(path.join(PUBLIC, 'automation-report.html'));
});

app.get('/ubazar-report', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'ubazar-report.html'));
});

app.get('/ubazar-match', (req, res) => {
  const q = new URLSearchParams(req.query || {});
  q.set('mode', 'ubazar');
  return res.redirect('/?' + q.toString());
});

ensureFiles();

const server = app.listen(PORT, () => {
  console.log(`Match review UI: http://localhost:${PORT}`);
  console.log(
    `API: /api/report, /api/sync-gastronom (POST), /api/unpaired-gastronom, /api/unpaired-supplier, /api/confirm, /api/no-match, /api/search?q=`
  );
  console.log('Inventory + full variant sync: productVariantsBulkUpdate / productOptionUpdate / variant sync API (restart after editing src/).');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use. Another \"npm run review\" (or Node) is running.\n` +
        `  Stop it: Task Manager / End process on that port, or:\n` +
        `  PowerShell: Get-NetTCPConnection -LocalPort ${PORT} | Select OwningProcess\n` +
        `  Then: Stop-Process -Id <pid> -Force\n` +
        `  Or use a different port: set REVIEW_PORT=3002 && npm run review\n`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
