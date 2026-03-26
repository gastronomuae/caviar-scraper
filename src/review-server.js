/* Default broad supplier filter (caviar + seafood + common seafood terms). Set PRODUCT_MATCH_BROAD=0 for strict caviar|seafood only. */
if (process.env.PRODUCT_MATCH_BROAD === undefined) {
  process.env.PRODUCT_MATCH_BROAD = '1';
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

const {
  getAccessToken,
  getLocationIdByName,
  setAvailableQuantity,
  setVariantInventoryPolicy,
  setProductStatus,
  graphql: shopifyGraphql
} = require('./shopify-inventory');
const { executeVariantSyncFromSupplier } = require('./shopify-variant-sync');
const {
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
} = require('./product-match');
const {
  normalizeToGastronomFileShape,
  runSyncGastronomFromShopify
} = require('./sync-shopify-gastronom');

const app = express();
/** @type {Promise<unknown> | null} */
let gastronomSyncInFlight = null;
/** @type {Promise<unknown> | null} */
let dailyAutomationInFlight = null;

const AUTOMATION_LAST_JSON = path.join(__dirname, '..', 'Output', 'automation_last_run.json');
const AUTOMATION_LAST_TXT = path.join(__dirname, '..', 'Output', 'automation_last_run.txt');

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

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? String(x) : '0';
}

function buildAutomationTextLog(run) {
  const lines = [];
  lines.push(`Automation run`);
  lines.push(`Started: ${run.started_at || '—'}`);
  lines.push(`Finished: ${run.finished_at || '—'}`);
  lines.push(`Result: ${run.ok ? 'OK' : 'FAILED'}`);
  lines.push('');

  const c = run.counts || {};
  lines.push(`Summary`);
  lines.push(`- Supplier latest products: ${fmt(c.supplier_latest_products)}`);
  lines.push(`- Supplier delta updated: ${fmt(c.supplier_delta_updated)}`);
  lines.push(`- Drafted unpaired ACTIVE: ${fmt(c.drafted_unpaired_active)} (failed ${fmt(c.drafted_failures)})`);
  lines.push(`- Variant sync OK: ${fmt(c.variant_sync_ok)} (failed ${fmt(c.variant_sync_failed)})`);
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
const PORT = Number(process.env.REVIEW_PORT || 3001);
const PUBLIC = path.join(__dirname, '../public');
const SNAP_DIR = path.join(__dirname, '../Output/snapshots/supplier');
const SUPPLIER_LATEST = PATHS.supplierLatest || path.join(__dirname, '../Output/products_all.latest.json');
const SHOPIFY_LOCATION_NAME = (process.env.SHOPIFY_LOCATION_NAME || 'Al Quoz Industrial Area 4').trim();
const SHOPIFY_LOCATION_ID = (process.env.SHOPIFY_LOCATION_ID || '').trim();

app.use(express.json());

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

  dailyAutomationInFlight = (async () => {
    const started_at = new Date().toISOString();
    const result = {
      ok: true,
      started_at,
      steps: /** @type {any[]} */ ([]),
      warnings: /** @type {string[]} */ ([]),
      errors: /** @type {string[]} */ ([]),
      counts: {
        supplier_latest_products: 0,
        supplier_delta_updated: 0,
        drafted_unpaired_active: 0,
        drafted_failures: 0,
        variant_sync_ok: 0,
        variant_sync_failed: 0
      }
    };

    // Step 1: Shopify -> Output/from_gastronom.json
    try {
      const r = await runSyncGastronomFromShopify();
      result.steps.push({ step: 'sync_gastronom', ok: true, ...r });
    } catch (e) {
      result.ok = false;
      result.errors.push(`sync_gastronom: ${String(e.message || e)}`);
      result.steps.push({ step: 'sync_gastronom', ok: false, error: String(e.message || e) });
      return result;
    }

    // Step 2: supplier scan -> latest, snapshot existing staged, delta, publish latest
    const stagedBefore = readSupplierFile(PATHS.supplier);
    try {
      const rScan = await execNodeScript(path.join(__dirname, 'fetch-products-all-1caviar.js'));
      result.steps.push({ step: 'supplier_scan', ok: true, note: 'Wrote Output/products_all.latest.json', ...rScan });
    } catch (e) {
      result.ok = false;
      result.errors.push(`supplier_scan: ${String(e.message || e)}`);
      result.steps.push({ step: 'supplier_scan', ok: false, error: String(e.message || e) });
      return result;
    }

    const snap = saveSupplierSnapshot();
    result.steps.push({ step: 'supplier_snapshot', ok: true, ...snap });

    const latestArr = readSupplierFile(SUPPLIER_LATEST);
    result.counts.supplier_latest_products = latestArr.length;
    const delta = diffSupplierSnapshots(Array.isArray(stagedBefore) ? stagedBefore : [], latestArr);
    result.counts.supplier_delta_updated = delta.updated.length;
    result.steps.push({
      step: 'supplier_delta',
      ok: true,
      counts: { added: delta.added.length, removed: delta.removed.length, updated: delta.updated.length }
    });

    const pub = publishLatestSupplier();
    result.steps.push({ step: 'supplier_publish', ok: true, ...pub });

    // Step 3: Draft ACTIVE unpaired Gastronom products
    try {
      const { products, active } = getUnpairedGastronomProducts();
      const targets = (products || []).filter(
        (p) => p?.shopify_product_id && String(p.status || '').trim().toUpperCase() === 'ACTIVE'
      );
      const drafted = [];
      const failed = [];
      for (const p of targets) {
        try {
          await setProductStatus(p.shopify_product_id, 'DRAFT');
          drafted.push(p.shopify_product_id);
        } catch (e) {
          failed.push({ shopify_product_id: p.shopify_product_id, handle: p.handle, error: String(e.message || e) });
        }
      }
      result.counts.drafted_unpaired_active = drafted.length;
      result.counts.drafted_failures = failed.length;
      result.steps.push({
        step: 'draft_unpaired_active',
        ok: failed.length === 0,
        list_active_count: active,
        eligible_active: targets.length,
        drafted: drafted.length,
        failed
      });
    } catch (e) {
      result.ok = false;
      result.errors.push(`draft_unpaired_active: ${String(e.message || e)}`);
      result.steps.push({ step: 'draft_unpaired_active', ok: false, error: String(e.message || e) });
      // continue; we still try variant sync
    }

    // Step 4: Sync variants for all confirmed mapped products that exist in both supplier + Gastronom export.
    try {
      const mapping = loadMapping();
      const shopify = loadShopifyNormalized();
      const gastronomGids = new Set(shopify.map((s) => s.shopify_product_id).filter(Boolean));
      const loc = SHOPIFY_LOCATION_ID || SHOPIFY_LOCATION_NAME;

      /** @type {{ source_handle: string, shopify_product_id: string }[]} */
      const syncTargets = [];
      /** @type {{ source_handle: string, shopify_product_id: string, reason: string }[]} */
      const skipped = [];
      for (const [hRaw, gidRaw] of Object.entries(mapping || {})) {
        const h = String(hRaw || '').trim();
        const gid = String(gidRaw || '').trim();
        if (!h || !gid) continue;
        const supplier = readSupplierProductByHandle(h);
        if (!supplier) {
          skipped.push({ source_handle: h, shopify_product_id: gid, reason: 'no supplier row for handle (not in products_all.json)' });
          continue;
        }
        if (!gastronomGids.has(gid)) {
          skipped.push({ source_handle: h, shopify_product_id: gid, reason: 'mapped GID not present in from_gastronom.json (vendor filter?)' });
          continue;
        }
        syncTargets.push({ source_handle: h, shopify_product_id: gid });
      }

      const ok = /** @type {any[]} */ ([]);
      const failed = /** @type {any[]} */ ([]);
      for (const t of syncTargets) {
        try {
          const supplier = readSupplierProductByHandle(t.source_handle);
          if (!supplier) throw new Error(`No supplier row for handle: ${t.source_handle}`);
          const r = await executeVariantSyncFromSupplier(t.shopify_product_id, supplier, loc, { dryRun: false });
          ok.push({
            ...t,
            supplier_name: supplier?.name ?? '',
            supplier_url: supplier?.url ?? '',
            set_active_after_sync: Boolean(r?.set_active_after_sync),
            applied: r?.applied || null
          });
        } catch (e) {
          failed.push({ ...t, error: String(e.message || e) });
        }
      }

      result.counts.variant_sync_ok = ok.length;
      result.counts.variant_sync_failed = failed.length;
      result.steps.push({
        step: 'variant_sync_mapped_updates',
        ok: failed.length === 0,
        targets: syncTargets.length,
        ok_count: ok.length,
        failed_count: failed.length,
        ok_items: ok,
        skipped_count: skipped.length,
        skipped: skipped,
        failed
      });
    } catch (e) {
      result.ok = false;
      result.errors.push(`variant_sync_mapped_updates: ${String(e.message || e)}`);
      result.steps.push({ step: 'variant_sync_mapped_updates', ok: false, error: String(e.message || e) });
    }

    result.finished_at = new Date().toISOString();

    // Persist an easy-to-read report for operators.
    try {
      ensureOutputDir();
      fs.writeFileSync(AUTOMATION_LAST_JSON, JSON.stringify(result, null, 2), 'utf8');
      fs.writeFileSync(AUTOMATION_LAST_TXT, buildAutomationTextLog(result), 'utf8');
      result.report_paths = {
        json: path.basename(AUTOMATION_LAST_JSON),
        txt: path.basename(AUTOMATION_LAST_TXT)
      };
    } catch (e) {
      result.warnings.push(`Could not write automation report files: ${String(e.message || e)}`);
    }

    return result;
  })().finally(() => {
    dailyAutomationInFlight = null;
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
    const { source_handle, shopify_product_id, dry_run } = req.body || {};
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

app.get('/', (req, res) => sendReviewHtml(res));
app.get('/review.html', (req, res) => sendReviewHtml(res));

app.use(express.static(PUBLIC));

app.get('/supplier-delta', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'supplier-delta.html'));
});

app.get('/automation-report', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'automation-report.html'));
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
