/* Default broad supplier filter (caviar + seafood + common seafood terms). Set PRODUCT_MATCH_BROAD=0 for strict caviar|seafood only. */
if (process.env.PRODUCT_MATCH_BROAD === undefined) {
  process.env.PRODUCT_MATCH_BROAD = '1';
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
const SUPPLIER_DELTA_HISTORY_PATH = path.join(__dirname, '..', 'Output', 'supplier_delta_history', 'history.json');

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
        ensureOutputDir();
        fs.writeFileSync(AUTOMATION_LAST_JSON, JSON.stringify(result, null, 2), 'utf8');
        fs.writeFileSync(AUTOMATION_LAST_TXT, buildAutomationTextLog(result), 'utf8');
        result.report_paths = { json: path.basename(AUTOMATION_LAST_JSON), txt: path.basename(AUTOMATION_LAST_TXT) };
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
