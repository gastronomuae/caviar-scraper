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

function ingestGastronomPayload(req, res) {
  console.log('📦 Incoming Gastronom webhook (full-catalog upsert)');

  const data = req.body;
  const incoming = Array.isArray(data) ? data : [data];

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

  const merged = mergeIncomingFullSnapshot(incoming);
  const prevKeyed = countKeyedRows(existing);
  const nextKeyed = countKeyedRows(merged);
  const prevKeys = new Set(existing.map(productKey).filter(Boolean));
  const nextKeys = new Set(merged.map(productKey).filter(Boolean));

  if (shrinkWouldBeSuspicious(prevKeyed, nextKeyed) && !forceReplace(req)) {
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
    `💾 Saved to Output/from_gastronom.json — total: ${merged.length} (added: ${added}, updated: ${updated}, removed from file: ${removed})`
  );

  res.json({
    status: 'ok',
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
