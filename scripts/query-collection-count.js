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
  const raw = process.argv[2];
  const id = String(raw || '').trim();
  if (!id) {
    console.error('Usage: node scripts/query-collection-count.js <collection_numeric_id>');
    process.exit(2);
  }

  const { getAccessToken, graphql } = require('../src/shopify-inventory');
  const token = await getAccessToken();
  const gid = `gid://shopify/Collection/${id}`;
  const data = await graphql(
    token,
    'query($id: ID!){ collection(id:$id){ id title productsCount(limit: null) { count } } }',
    { id: gid }
  );
  if (!data?.collection?.id) {
    console.error('Collection not found or not accessible.');
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      { id: data.collection.id, title: data.collection.title, productsCount: data.collection.productsCount?.count ?? null },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});

