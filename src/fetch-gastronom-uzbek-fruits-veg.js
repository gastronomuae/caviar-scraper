const fs = require('fs');
const path = require('path');

const COLLECTION_GID = 'gid://shopify/Collection/322826764457';
const OUT = path.join(__dirname, '..', 'Output', 'gastronom_uzbek_fruits_veg.latest.json');
const STORE_ORIGIN = 'https://www.gastronom.ae';

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function scoreName(a, b) {
  return Math.round(100 * jaccard(tokenize(a), tokenize(b)));
}

function loadEnvIfMissing() {
  const envPath = path.join(__dirname, '..', 'scripts', 'shopify-test', '.env');
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

async function fetchCollectionProductsViaAdmin() {
  loadEnvIfMissing();
  const { getAccessToken, graphql } = require('./shopify-inventory');
  const token = await getAccessToken();
  const products = [];
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
            edges {
              node {
                id
                title
                handle
                status
                featuredImage { url }
                variants(first: 1) {
                  edges {
                    node {
                      price
                      availableForSale
                      weight
                      weightUnit
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { id: COLLECTION_GID, after }
    );
    const col = data?.collection;
    const edges = col?.products?.edges || [];
    for (const e of edges) {
      const n = e?.node;
      if (!n?.handle) continue;
      const v = n?.variants?.edges?.[0]?.node || {};
      const weightRaw = v?.weight != null ? Number(v.weight) : null;
      const weightUnit = String(v?.weightUnit || '').toUpperCase();
      let weightG = null;
      if (weightRaw != null && weightRaw > 0) {
        if (weightUnit === 'GRAMS') weightG = Math.round(weightRaw);
        else if (weightUnit === 'KILOGRAMS') weightG = Math.round(weightRaw * 1000);
        else if (weightUnit === 'OUNCES') weightG = Math.round(weightRaw * 28.35);
        else if (weightUnit === 'POUNDS') weightG = Math.round(weightRaw * 453.59);
        else weightG = Math.round(weightRaw); // fallback: assume grams
      }
      products.push({
        name: n.title,
        handle: n.handle,
        url: `${STORE_ORIGIN}/products/${n.handle}`,
        image: n?.featuredImage?.url || null,
        product_status: n?.status || null,
        price: v?.price != null ? Number(v.price) : null,
        available: v?.availableForSale ?? null,
        weight_g: weightG
      });
    }
    const pi = col?.products?.pageInfo || {};
    if (!pi.hasNextPage) {
      return { collection: { id: col?.id, title: col?.title }, products };
    }
    after = pi.endCursor || null;
    if (!after) break;
  }
  return { collection: { id: null, title: null }, products };
}

function loadJson(p) {
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (_) {
    return [];
  }
}

function buildMatchReport(ubazarProducts, gastronomProducts) {
  const rows = [];
  for (const u of ubazarProducts) {
    const scored = gastronomProducts
      .map((g) => ({
        ...g,
        score: scoreName(u.name, g.name)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    rows.push({
      ubazar: u,
      suggestions: scored
    });
  }
  return rows;
}

async function main() {
  const { collection, products } = await fetchCollectionProductsViaAdmin();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        scraped_at: new Date().toISOString(),
        source: { type: 'shopify_admin_collection', id: COLLECTION_GID, title: collection?.title || null },
        products
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`Gastronom collection: saved ${products.length} rows -> ${OUT}`);

  // Build quick local match report if UBazar file exists.
  const ubazar = loadJson(path.join(__dirname, '..', 'Output', 'ubazar_products.latest.json'));
  if (ubazar.length) {
    const matchOut = path.join(__dirname, '..', 'Output', 'ubazar_match_report.latest.json');
    const rows = buildMatchReport(ubazar, products);
    fs.writeFileSync(
      matchOut,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          ubazar_count: ubazar.length,
          gastronom_count: products.length,
          rows
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`Match report: ${matchOut}`);
  }
}

module.exports = { buildMatchReport };

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}

