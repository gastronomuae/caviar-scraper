const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

/** If existing catalog has at least this many rows, reject “tiny” replacements (Make partial payload). */
const PROTECT_MIN_EXISTING = Math.max(
  0,
  Number(process.env.GASTRONOM_SYNC_PROTECT_MIN_EXISTING || '5')
);
/** When shrinking, incoming must have at least this many rows OR this fraction of existing (whichever is larger). */
const SHRINK_MIN_FRACTION = Math.min(
  1,
  Math.max(0.05, Number(process.env.GASTRONOM_SYNC_SHRINK_MIN_FRACTION || '0.2'))
);
const BACKUP_NAME = process.env.GASTRONOM_BACKUP_NAME || 'from_gastronom.json.bak';

function countKeyedRows(list) {
  if (!Array.isArray(list)) return 0;
  return list.map(productKey).filter(Boolean).length;
}

function normalizeIncomingVariants(p) {
  if (!p || typeof p !== 'object') return undefined;
  // Make.com sometimes sends `Variants` (capital V) as a nested array-of-arrays
  const raw = p.variants ?? p.Variants;
  if (raw == null) return undefined;

  /** @type {any[]} */
  const flat = [];
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (Array.isArray(x)) flat.push(...x);
      else flat.push(x);
    }
  } else {
    flat.push(raw);
  }

  const out = [];
  for (const v of flat) {
    if (!v || typeof v !== 'object') continue;
    const shopify_variant_id = v.shopify_variant_id || v.shopifyVariantId || v.id || null;
    // Prefer explicit weight; otherwise parse from title like "360 г."
    const weight =
      v.weight != null
        ? String(v.weight)
        : v.title != null
          ? String(v.title)
          : null;
    const price = v.price != null ? String(v.price) : null;
    const stock =
      v.stock != null
        ? String(v.stock)
        : v.inventoryQuantity != null
          ? String(v.inventoryQuantity)
          : null;
    if (!shopify_variant_id && !weight && !price && stock == null) continue;
    out.push({
      price,
      stock,
      weight,
      shopify_variant_id,
      sku: v.sku ?? null,
      barcode: v.barcode ?? null
    });
  }
  return out;
}

function normalizeIncomingProduct(p) {
  if (!p || typeof p !== 'object') return p;
  const variants = normalizeIncomingVariants(p);
  // Keep all original fields, but ensure our canonical lowercase `variants` exists when present.
  const out = { ...p };
  if (variants !== undefined) out.variants = variants;
  // Avoid persisting the nested Make-only key unless someone wants it for debugging.
  if (out.Variants !== undefined) delete out.Variants;
  return out;
}

function shrinkWouldBeSuspicious(prevKeyed, nextKeyed) {
  if (PROTECT_MIN_EXISTING <= 0) return false;
  if (prevKeyed < PROTECT_MIN_EXISTING) return false;
  if (nextKeyed >= prevKeyed) return false;
  const minIncoming = Math.max(2, Math.ceil(prevKeyed * SHRINK_MIN_FRACTION));
  return nextKeyed < minIncoming;
}

function forceReplace(req) {
  const q = String(req.query?.force || '').trim();
  if (q === '1' || /^true$/i.test(q)) return true;
  const h = req.headers['x-gastronom-force-replace'];
  return h === '1' || String(h || '').toLowerCase() === 'true';
}

app.get('/', (req, res) => {
  res.send('Server is running');
});

/** Stable key: GID preferred, else handle. Skips rows with neither. */
function productKey(p) {
  if (!p || typeof p !== 'object') return null;
  const gid = p.shopify_product_id;
  if (gid != null && String(gid).trim() !== '') return `gid:${String(gid).trim()}`;
  const h = p.handle;
  if (h != null && String(h).trim() !== '') return `handle:${String(h).trim()}`;
  return null;
}

/**
 * Full-catalog sync from Make: no duplicate keys. Same GID/handle → replace with latest
 * payload row (price, Product Status, etc.). Keys only in the file but not in this batch are
 * dropped (delisted in Gastronom). Supplier handle → GID mapping lives in product_mapping.json
 * and is never modified here.
 */
function mergeIncomingFullSnapshot(incomingList) {
  const map = new Map();
  const order = [];
  for (const p of incomingList) {
    const k = productKey(p);
    if (!k) continue;
    if (!map.has(k)) order.push(k);
    map.set(k, p);
  }
  return order.map((k) => map.get(k));
}

/**
 * Delta sync: upsert incoming keys into existing list, keep everything else.
 * - Same key → replace row (price/status/etc.)
 * - New key → append to end
 * - No deletions
 */
function mergeIncomingDelta(existingList, incomingList) {
  const incomingMap = new Map();
  const incomingOrder = [];
  for (const p of incomingList) {
    const k = productKey(p);
    if (!k) continue;
    if (!incomingMap.has(k)) incomingOrder.push(k);
    incomingMap.set(k, p); // last row wins if duplicated
  }

  const out = [];
  const used = new Set();
  for (const prev of existingList) {
    const k = productKey(prev);
    if (k && incomingMap.has(k)) {
      const inc = incomingMap.get(k);
      // Delta payloads may omit fields; merge to avoid wiping existing data.
      const merged = { ...(prev || {}), ...(inc || {}) };
      // Preserve variants unless explicitly provided in the incoming payload.
      if (!('variants' in (inc || {})) || !Array.isArray(inc?.variants)) {
        if (prev && 'variants' in prev) merged.variants = prev.variants;
      }
      // Preserve image fields unless explicitly provided.
      if (!('Image url' in (inc || {})) && prev && 'Image url' in prev) merged['Image url'] = prev['Image url'];
      if (!('image' in (inc || {})) && prev && 'image' in prev) merged.image = prev.image;
      out.push(merged);
      used.add(k);
    } else {
      out.push(prev);
    }
  }
  for (const k of incomingOrder) {
    if (used.has(k)) continue;
    out.push(incomingMap.get(k));
  }
  return out;
}

function ingestGastronomPayload(req, res) {
  console.log('📦 Incoming Gastronom webhook');

  const data = req.body;
  const isArrayPayload = Array.isArray(data);
  const requestedMode = String(req.query?.mode || '').trim().toLowerCase();
  /**
   * Default behavior: DELTA UPSERT ALWAYS.
   * - Whatever Make sends (1 product or an array) → upsert into existing file
   * - Never delete existing rows
   *
   * Opt-in snapshot (deletes missing keys) only if mode=snapshot is passed.
   */
  const mode = requestedMode === 'snapshot' ? 'snapshot' : 'delta';
  const incomingRaw = isArrayPayload ? data : [data];
  const incoming = incomingRaw.map(normalizeIncomingProduct);

  const payloadStr = JSON.stringify(data);
  if (process.env.DEBUG_GASTRONOM_PAYLOAD === '1' || payloadStr.length <= 8000) {
    console.log('📊 Payload:', payloadStr.length > 8000 ? payloadStr.slice(0, 8000) + '… [truncated]' : payloadStr);
  } else {
    console.log(`📊 Payload: ${payloadStr.length} chars (set DEBUG_GASTRONOM_PAYLOAD=1 to log body)`);
  }

  const filePath = path.join(__dirname, '../Output/from_gastronom.json');
  let existing = [];

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      existing = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      existing = [];
    }
  }

  // Reject payloads where no keyed rows exist at all (prevents writing junk)
  const incomingKeyed = incoming.map(productKey).filter(Boolean).length;
  if (incomingKeyed === 0) {
    return res.status(400).json({
      status: 'rejected',
      error: 'missing_keys',
      message: 'Incoming payload contained no rows with shopify_product_id or handle.'
    });
  }

  const merged =
    mode === 'snapshot' ? mergeIncomingFullSnapshot(incoming) : mergeIncomingDelta(existing, incoming);
  const prevKeyed = countKeyedRows(existing);
  const nextKeyed = countKeyedRows(merged);
  const prevKeys = new Set(existing.map(productKey).filter(Boolean));
  const nextKeys = new Set(merged.map(productKey).filter(Boolean));

  if (mode === 'snapshot' && shrinkWouldBeSuspicious(prevKeyed, nextKeyed) && !forceReplace(req)) {
    const minRequired = Math.max(2, Math.ceil(prevKeyed * SHRINK_MIN_FRACTION));
    console.warn(
      `⛔ Rejected sync: would shrink keyed rows ${prevKeyed} → ${nextKeyed} (need ≥${minRequired} or ?force=1 / header x-gastronom-force-replace: 1)`
    );
    return res.status(409).json({
      status: 'rejected',
      error: 'suspicious_shrink',
      message:
        'Incoming batch is much smaller than the saved catalog — likely a partial Make payload. File not changed.',
      previous_keyed_rows: prevKeyed,
      incoming_keyed_rows: nextKeyed,
      min_keyed_rows_for_shrink: minRequired,
      bypass:
        'Send ?force=1 on the URL or header x-gastronom-force-replace: 1 if you really want to replace the full file with this smaller set.'
    });
  }

  let added = 0;
  let updated = 0;
  for (const k of nextKeys) {
    if (prevKeys.has(k)) updated++;
    else added++;
  }
  const removed = [...prevKeys].filter((k) => !nextKeys.has(k)).length;

  if (fs.existsSync(filePath) && existing.length > 0) {
    const backupPath = path.join(path.dirname(filePath), BACKUP_NAME);
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (e) {
      console.warn('⚠️ Could not write backup:', e.message);
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));

  console.log(
    `💾 Saved to Output/from_gastronom.json — mode: ${mode} — total: ${merged.length} (added: ${added}, updated: ${updated}, removed from file: ${removed})`
  );

  res.json({
    status: 'ok',
    mode,
    received: incoming.length,
    total: merged.length,
    added,
    updated,
    removed_from_file: removed
  });
}

app.post('/gastronom', ingestGastronomPayload);
/** @deprecated Use POST /gastronom — kept for existing webhook URLs */
app.post('/shopify', ingestGastronomPayload);

app.listen(3000, () => {
  console.log(
    '🚀 Server running on port 3000 — POST /gastronom or /shopify → Output/from_gastronom.json (shrink guard + .bak backup; see docs)'
  );
});
