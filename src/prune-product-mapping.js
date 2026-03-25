/**
 * Remove product_mapping entries whose supplier handle no longer exists in products_all.json.
 * Run after regenerating products_all from collections.
 *
 *   node src/prune-product-mapping.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAP = path.join(ROOT, 'Output/product_mapping.json');
// Use staged supplier file (approved for dashboard).
const ALL = path.join(ROOT, 'Output/products_all.json');

function handleFromUrl(url) {
  const m = String(url || '').match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

function main() {
  const products = JSON.parse(fs.readFileSync(ALL, 'utf8'));
  const valid = new Set(
    (Array.isArray(products) ? products : []).map((p) => handleFromUrl(p.url)).filter(Boolean)
  );
  const mapping = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const pruned = {};
  let removed = 0;
  for (const [k, v] of Object.entries(mapping)) {
    if (valid.has(k)) pruned[k] = v;
    else removed++;
  }
  fs.writeFileSync(MAP, JSON.stringify(pruned, null, 2) + '\n', 'utf8');
  console.log(`Kept ${Object.keys(pruned).length}, removed ${removed} orphan keys → ${MAP}`);
}

main();
