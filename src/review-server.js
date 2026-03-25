/* Default broad supplier filter (caviar + seafood + common seafood terms). Set PRODUCT_MATCH_BROAD=0 for strict caviar|seafood only. */
if (process.env.PRODUCT_MATCH_BROAD === undefined) {
  process.env.PRODUCT_MATCH_BROAD = '1';
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  buildMatchingReport,
  writeMatchingReportCsv,
  finalReport,
  loadMapping,
  loadState,
  saveMapping,
  saveState,
  loadShopifyNormalized,
  getUnpairedGastronomProducts,
  getUnpairedSupplierProducts,
  PATHS
} = require('./product-match');

const app = express();
const PORT = Number(process.env.REVIEW_PORT || 3001);
const PUBLIC = path.join(__dirname, '../public');
const SNAP_DIR = path.join(__dirname, '../Output/snapshots/supplier');
const SUPPLIER_LATEST = PATHS.supplierLatest || path.join(__dirname, '../Output/products_all.latest.json');

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

app.use(express.static(PUBLIC));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'review.html'));
});

app.get('/supplier-delta', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'supplier-delta.html'));
});

ensureFiles();

const server = app.listen(PORT, () => {
  console.log(`Match review UI: http://localhost:${PORT}`);
  console.log(
    `API: /api/report, /api/unpaired-gastronom, /api/unpaired-supplier, /api/confirm, /api/no-match, /api/search?q=`
  );
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
