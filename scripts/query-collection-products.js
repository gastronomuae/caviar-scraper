const fs = require('fs');
const path = require('path');

function loadEnvIfMissing() {
  const envPath = path.join(__dirname, 'shopify-test', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    if (process.env[k] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

async function main() {
  loadEnvIfMissing();
  const numeric = String(process.argv[2] || '').trim();
  if (!numeric) {
    console.error('Usage: node scripts/query-collection-products.js <collection_numeric_id>');
    process.exit(2);
  }
  const { getAccessToken, graphql } = require('../src/shopify-inventory');
  const token = await getAccessToken();
  const gid = `gid://shopify/Collection/${numeric}`;

  const rows = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await graphql(
      token,
      `query Col($id: ID!, $after: String) {
        collection(id: $id) {
          id
          title
          products(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { id handle title status } }
          }
        }
      }`,
      { id: gid, after }
    );
    const col = data?.collection;
    const edges = col?.products?.edges || [];
    for (const e of edges) {
      const n = e?.node;
      if (!n?.handle) continue;
      rows.push({ handle: n.handle, status: n.status, title: n.title, product_id: n.id });
    }
    const pi = col?.products?.pageInfo || {};
    if (!pi.hasNextPage) break;
    after = pi.endCursor || null;
    if (!after) break;
  }

  rows.sort((a, b) => a.handle.localeCompare(b.handle, 'ru'));
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});

