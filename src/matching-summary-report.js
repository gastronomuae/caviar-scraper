/**
 * One-shot stats: supplier scope, mapping coverage, many-to-one collisions, Gastronom orphans.
 *   node src/matching-summary-report.js
 */
const fs = require('fs');
const path = require('path');
const {
  filterSupplierCaviarSeafood,
  normalizeSupplier,
  loadShopifyNormalized,
  loadMapping,
  loadState,
  PATHS
} = require('./product-match');

function shopifyByHandle(shopifyList) {
  const m = new Map();
  for (const s of shopifyList) {
    if (s.handle) m.set(s.handle, s);
  }
  return m;
}

function extractHandleFromUrl(url) {
  const m = String(url || '').match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const supplierRaw = loadJson(PATHS.supplier);
  const supplierArr = Array.isArray(supplierRaw) ? supplierRaw : [];
  const supplierHandlesAll = new Set(
    supplierArr.map((p) => extractHandleFromUrl(p.url)).filter(Boolean)
  );

  const filtered = filterSupplierCaviarSeafood(supplierArr);
  const supplierNorm = filtered.map(normalizeSupplier).filter((s) => s.handle);
  const scopeHandles = new Set(supplierNorm.map((s) => s.handle));

  const shopify = loadShopifyNormalized();
  const byHandle = shopifyByHandle(shopify);
  const mapping = loadMapping();
  const state = loadState();
  const noSet = new Set(state.noMatchHandles || []);

  let confirmed = 0;
  let noMatch = 0;
  let autoByHandle = 0;
  let needsReview = 0;

  for (const s of supplierNorm) {
    const h = s.handle;
    const confirmedGid = mapping[h];
    const exact = byHandle.get(h);

    if (confirmedGid) confirmed++;
    else if (noSet.has(h)) noMatch++;
    else if (exact) autoByHandle++;
    else needsReview++;
  }

  /** Supplier handles present in JSON that map to same Shopify GID */
  const gidToSupplierHandles = new Map();
  for (const [h, gid] of Object.entries(mapping)) {
    if (!supplierHandlesAll.has(h)) continue;
    if (!gid) continue;
    if (!gidToSupplierHandles.has(gid)) gidToSupplierHandles.set(gid, []);
    gidToSupplierHandles.get(gid).push(h);
  }
  const manySupplierOneGastronom = [...gidToSupplierHandles.entries()].filter(
    ([, handles]) => handles.length > 1
  );

  /** Duplicate GID rows inside from_gastronom.json (should be rare) */
  const gastronomGidCounts = new Map();
  for (const row of shopify) {
    const g = row.shopify_product_id;
    if (!g) continue;
    gastronomGidCounts.set(g, (gastronomGidCounts.get(g) || 0) + 1);
  }
  const duplicateGastronomGids = [...gastronomGidCounts.entries()].filter(([, n]) => n > 1);

  /** Gastronom row paired to Caviar N1 if: same handle exists on supplier site OR some supplier handle maps to this GID */
  const mappedGidsFromOurSuppliers = new Set();
  for (const [h, gid] of Object.entries(mapping)) {
    if (supplierHandlesAll.has(h) && gid) mappedGidsFromOurSuppliers.add(gid);
  }

  const gastronomUnpaired = [];
  for (const row of shopify) {
    const g = row.shopify_product_id;
    const h = row.handle;
    if (!g) continue;
    const byMapping = mappedGidsFromOurSuppliers.has(g);
    const bySharedHandle = h && supplierHandlesAll.has(h);
    if (!byMapping && !bySharedHandle) {
      gastronomUnpaired.push({ handle: h, gid: g, name: row.name_ru });
    }
  }

  const lines = [];
  lines.push('=== Caviar N1 ↔ Gastronom matching summary ===\n');
  lines.push(`Supplier JSON: ${PATHS.supplier}`);
  lines.push(`  Total products in file: ${supplierArr.length}`);
  lines.push(`  In review scope (caviar/seafood filter): ${supplierNorm.length}\n`);

  lines.push('--- Supplier side (scoped rows only) ---');
  lines.push(`  Confirmed (saved in product_mapping.json): ${confirmed}`);
  lines.push(`  Marked “no match” (review state):          ${noMatch}`);
  lines.push(`  Auto: same handle as a Gastronom row:      ${autoByHandle}`);
  lines.push(`  Still needs review (no mapping, not no-match, no handle match): ${needsReview}`);
  lines.push(
    `  (Sanity: ${confirmed + noMatch + autoByHandle + needsReview} = ${supplierNorm.length})\n`
  );

  lines.push('--- Duplication / collisions ---');
  lines.push(
    `  Duplicate Gastronom rows (same shopify_product_id twice in from_gastronom.json): ${duplicateGastronomGids.length}`
  );
  if (duplicateGastronomGids.length) {
    for (const [gid, n] of duplicateGastronomGids) {
      lines.push(`    • ${n}× ${gid}`);
    }
  }
  lines.push(
    `  Multiple Caviar N1 supplier handles → same Gastronom product (same GID in mapping): ${manySupplierOneGastronom.length}`
  );
  if (manySupplierOneGastronom.length) {
    for (const [gid, handles] of manySupplierOneGastronom) {
      lines.push(`    • ${gid}`);
      for (const x of handles) lines.push(`        - ${x}`);
    }
  }
  lines.push(
    '  (The reverse—a single supplier handle mapping to two Gastronom products—is impossible in product_mapping.json because each handle has one value.)\n'
  );

  lines.push('--- Gastronom export (from_gastronom.json) ---');
  lines.push(`  Products in export: ${shopify.length}`);
  lines.push(
    `  Not linked back to any Caviar N1 product in products_all.json: ${gastronomUnpaired.length}`
  );
  lines.push(
    '      (A row counts as linked if a supplier URL handle equals its handle, or some supplier handle maps to its shopify_product_id.)'
  );
  if (gastronomUnpaired.length && gastronomUnpaired.length <= 40) {
    lines.push('  Unpaired list:');
    for (const x of gastronomUnpaired) {
      lines.push(`    • ${x.handle} | ${x.name.slice(0, 60)}`);
    }
  } else if (gastronomUnpaired.length > 40) {
    lines.push(`  (First 25 of ${gastronomUnpaired.length} unpaired:)`);
    for (const x of gastronomUnpaired.slice(0, 25)) {
      lines.push(`    • ${x.handle} | ${x.name.slice(0, 60)}`);
    }
  }

  const text = lines.join('\n');
  console.log(text);
  const out = path.join(path.dirname(PATHS.supplier), 'matching_summary_report.txt');
  fs.writeFileSync(out, text + '\n', 'utf8');
  console.log(`\nAlso wrote ${out}`);
}

main();
