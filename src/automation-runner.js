const fs = require('fs');
const path = require('path');

const {
  loadMapping,
  loadShopifyNormalized,
  getUnpairedGastronomProducts,
  PATHS
} = require('./product-match');
const { runSyncGastronomFromShopify } = require('./sync-shopify-gastronom');
const { executeVariantSyncFromSupplier } = require('./shopify-variant-sync');
const { setProductStatus } = require('./shopify-inventory');
const supplierFetch = require('./fetch-products-all-1caviar');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function createFileLock(lockPath) {
  ensureDir(path.dirname(lockPath));
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    if (e && (e.code === 'EEXIST' || String(e.message || '').includes('EEXIST'))) {
      throw new Error(`Lock exists: ${lockPath}`);
    }
    throw e;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n', 'utf8');
  return {
    lockPath,
    release() {
      try {
        fs.closeSync(fd);
      } catch (_) {}
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {}
    }
  };
}

function readSupplierFile(p) {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function extractHandleFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
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

function diffSupplierSnapshots(prevArr, nextArr) {
  const prevMap = new Map();
  const nextMap = new Map();
  for (const p of prevArr || []) {
    const k = supplierKey(p);
    if (k) prevMap.set(k, p);
  }
  for (const p of nextArr || []) {
    const k = supplierKey(p);
    if (k) nextMap.set(k, p);
  }
  const added = [];
  const removed = [];
  const updated = [];
  for (const [k, p] of nextMap) {
    if (!prevMap.has(k)) {
      added.push({ handle: k, name: p?.name ?? '', url: p?.url ?? '', image: p?.image ?? null });
      continue;
    }
    const a = supplierComparable(prevMap.get(k));
    const b = supplierComparable(p);
    const pushIf = (arr, field, av, bv) => {
      if (JSON.stringify(av) !== JSON.stringify(bv)) arr.push({ field, from: av, to: bv });
    };
    const changed = [];
    pushIf(changed, 'promotional_price', a.promotional_price, b.promotional_price);
    pushIf(changed, 'regular_price', a.regular_price, b.regular_price);
    pushIf(changed, 'variants', a.variants, b.variants);
    if (changed.length) updated.push({ handle: k, name: b.name || a.name || '', url: b.url || a.url || '', image: b.image ?? a.image ?? null, changed });
  }
  for (const [k, p] of prevMap) {
    if (!nextMap.has(k)) removed.push({ handle: k, name: p?.name ?? '', url: p?.url ?? '', image: p?.image ?? null });
  }
  return { added, removed, updated };
}

function saveSupplierSnapshot(snapDir) {
  ensureDir(snapDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(snapDir, `${stamp}.json`);
  const arr = readSupplierFile(PATHS.supplier);
  fs.writeFileSync(outPath, JSON.stringify(arr, null, 2), 'utf8');
  return { saved: path.basename(outPath), count: arr.length, full: outPath };
}

function publishLatestSupplier(latestPath) {
  if (!fs.existsSync(latestPath)) throw new Error(`Missing latest supplier file: ${latestPath}`);
  const latestArr = readSupplierFile(latestPath);
  ensureDir(path.dirname(PATHS.supplier));
  fs.copyFileSync(latestPath, PATHS.supplier);
  return { published: true, count: latestArr.length };
}

async function runSupplierScanToLatest() {
  await supplierFetch.main();
  return { ok: true, latest_path: supplierFetch.OUT };
}

async function runDailyAutomation(opts) {
  const {
    lockPath,
    supplierLatestPath,
    snapshotDir,
    shopifyLocationNameOrId
  } = opts || {};

  const lock = lockPath ? createFileLock(lockPath) : null;
  const started_at = new Date().toISOString();
  const result = {
    ok: true,
    started_at,
    steps: [],
    warnings: [],
    errors: [],
    counts: {
      supplier_latest_products: 0,
      supplier_delta_updated: 0,
      drafted_unpaired_active: 0,
      drafted_failures: 0,
      variant_sync_ok: 0,
      variant_sync_failed: 0
    }
  };

  try {
    const r1 = await runSyncGastronomFromShopify();
    result.steps.push({ step: 'sync_gastronom', ok: true, ...r1 });

    const stagedBefore = readSupplierFile(PATHS.supplier);
    await runSupplierScanToLatest();
    result.steps.push({ step: 'supplier_scan', ok: true, note: 'Wrote Output/products_all.latest.json' });

    const snap = saveSupplierSnapshot(snapshotDir);
    result.steps.push({ step: 'supplier_snapshot', ok: true, saved: snap.saved, count: snap.count });

    const latestArr = readSupplierFile(supplierLatestPath);
    result.counts.supplier_latest_products = latestArr.length;
    const delta = diffSupplierSnapshots(stagedBefore, latestArr);
    result.counts.supplier_delta_updated = delta.updated.length;
    result.steps.push({
      step: 'supplier_delta',
      ok: true,
      counts: { added: delta.added.length, removed: delta.removed.length, updated: delta.updated.length }
    });

    const pub = publishLatestSupplier(supplierLatestPath);
    result.steps.push({ step: 'supplier_publish', ok: true, ...pub });

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
    }

    // Sync variants for all confirmed mapped products (present in both supplier + Gastronom export).
    try {
      const mapping = loadMapping();
      const shopify = loadShopifyNormalized();
      const gastronomGids = new Set(shopify.map((s) => s.shopify_product_id).filter(Boolean));

      const syncTargets = [];
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
        syncTargets.push({ source_handle: h, shopify_product_id: gid, supplier });
      }

      const okItems = [];
      const failed = [];
      for (const t of syncTargets) {
        try {
          const r = await executeVariantSyncFromSupplier(
            t.shopify_product_id,
            t.supplier,
            shopifyLocationNameOrId,
            { dryRun: false }
          );
          okItems.push({
            source_handle: t.source_handle,
            shopify_product_id: t.shopify_product_id,
            supplier_name: t.supplier?.name ?? '',
            supplier_url: t.supplier?.url ?? '',
            set_active_after_sync: Boolean(r?.set_active_after_sync),
            applied: r?.applied || null
          });
        } catch (e) {
          failed.push({ source_handle: t.source_handle, shopify_product_id: t.shopify_product_id, error: String(e.message || e) });
        }
      }

      result.counts.variant_sync_ok = okItems.length;
      result.counts.variant_sync_failed = failed.length;
      result.steps.push({
        step: 'variant_sync_mapped_updates',
        ok: failed.length === 0,
        targets: syncTargets.length,
        ok_count: okItems.length,
        failed_count: failed.length,
        ok_items: okItems,
        skipped_count: skipped.length,
        skipped,
        failed
      });
    } catch (e) {
      result.ok = false;
      result.errors.push(`variant_sync_mapped_updates: ${String(e.message || e)}`);
      result.steps.push({ step: 'variant_sync_mapped_updates', ok: false, error: String(e.message || e) });
    }

    result.finished_at = new Date().toISOString();
    return result;
  } finally {
    if (lock) lock.release();
  }
}

module.exports = { runDailyAutomation, createFileLock };

