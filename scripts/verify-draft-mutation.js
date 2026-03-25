/**
 * Dev check: productChangeStatus via setProductStatus. Restores original status.
 * Usage: node scripts/verify-draft-mutation.js [productGid]
 * Env: scripts/shopify-test/.env (SHOP, CLIENT_ID, CLIENT_SECRET)
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, 'shopify-test', '.env');
if (!fs.existsSync(envPath)) {
  console.error('Missing', envPath);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const { getAccessToken, setProductStatus, graphql } = require('../src/shopify-inventory');

const PRODUCT_ID = process.argv[2] || 'gid://shopify/Product/8849229676713';

async function fetchProduct(token) {
  const d = await graphql(
    token,
    `query ($id: ID!) { product(id: $id) { id title status } }`,
    { id: PRODUCT_ID }
  );
  return d?.product || null;
}

async function main() {
  const token = await getAccessToken();
  const before = await fetchProduct(token);
  if (!before) throw new Error(`No product for ${PRODUCT_ID}`);

  const orig = String(before.status || '')
    .trim()
    .toUpperCase();
  console.log(JSON.stringify({ step: 'before', status: orig, title: before.title }, null, 0));

  await setProductStatus(PRODUCT_ID, 'DRAFT');
  const asDraft = await fetchProduct(token);
  const draftSt = String(asDraft?.status || '')
    .trim()
    .toUpperCase();
  console.log(JSON.stringify({ step: 'after_draft', status: draftSt, ok: draftSt === 'DRAFT' }, null, 0));
  if (draftSt !== 'DRAFT') throw new Error(`Expected DRAFT after mutation, got ${draftSt || 'null'}`);

  await setProductStatus(PRODUCT_ID, orig);
  const restored = await fetchProduct(token);
  const restSt = String(restored?.status || '')
    .trim()
    .toUpperCase();
  console.log(JSON.stringify({ step: 'restored', wanted: orig, got: restSt, ok: restSt === orig }, null, 0));
  if (restSt !== orig) throw new Error(`Restore failed: wanted ${orig}, got ${restSt}`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
