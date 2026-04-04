const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'Output/from_gastronom.json');
const TOKEN_CACHE_PATH = path.join(ROOT, 'Output/shopify_token_cache.json');
const DELTA_OUT_PATH = path.join(ROOT, 'Output/shopify_sync_delta.json');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function shopDomain() {
  // Accept either "gastronom-ae" or "gastronom-ae.myshopify.com"
  const raw = requireEnv('SHOP').trim();
  return raw.endsWith('.myshopify.com') ? raw : `${raw}.myshopify.com`;
}

function apiVersion() {
  return (process.env.API_VERSION || '2025-10').trim();
}

function readJsonIfExists(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function tokenCacheValid(cache) {
  if (!cache || typeof cache !== 'object') return false;
  const token = cache.access_token;
  const expires_at = cache.expires_at;
  if (!token || !expires_at) return false;
  const expMs = Date.parse(expires_at);
  if (!Number.isFinite(expMs)) return false;
  // refresh a bit early
  return expMs - Date.now() > 5 * 60 * 1000;
}

async function getAccessToken() {
  const cached = readJsonIfExists(TOKEN_CACHE_PATH, null);
  if (tokenCacheValid(cached)) return cached.access_token;

  const shop = shopDomain();
  const url = `https://${shop}/admin/oauth/access_token`;
  const client_id = requireEnv('CLIENT_ID').trim();
  const client_secret = requireEnv('CLIENT_SECRET').trim();

  const { data } = await axios.post(
    url,
    {
      grant_type: 'client_credentials',
      client_id,
      client_secret
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );

  const token = data && data.access_token;
  if (!token) throw new Error(`No access_token in response: ${JSON.stringify(data)}`);

  // Shopify returns expires_in (seconds) for client credentials
  const expiresIn = Number(data.expires_in || 0);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

  writeJson(TOKEN_CACHE_PATH, { access_token: token, expires_at: expiresAt, fetched_at: nowIso() });
  return token;
}

async function graphql(token, query, variables) {
  const shop = shopDomain();
  const url = `https://${shop}/admin/api/${apiVersion()}/graphql.json`;
  const { data } = await axios.post(
    url,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      timeout: 60000
    }
  );
  if (Array.isArray(data?.errors) && data.errors.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data?.data;
}

async function fetchAllVendorProducts(token, vendorName) {
  const q = `vendor:'${vendorName.replace(/'/g, "\\'")}'`;
  const all = [];
  let after = null;

  for (;;) {
    const data = await graphql(
      token,
      `query($q: String!, $after: String) {
        products(first: 250, query: $q, after: $after) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id
              title
              handle
              vendor
              status
              productType
              description
              featuredImage { url }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    sku
                    barcode
                    inventoryQuantity
                    inventoryPolicy
                  }
                }
              }
            }
          }
        }
      }`,
      { q, after }
    );

    const edges = data?.products?.edges || [];
    for (const e of edges) {
      if (e?.node) all.push(e.node);
    }
    const hasNext = Boolean(data?.products?.pageInfo?.hasNextPage);
    if (!hasNext) break;
    after = edges.length ? edges[edges.length - 1].cursor : null;
    if (!after) break;
  }

  return all;
}

function normalizeToGastronomFileShape(shopifyProduct) {
  const variantsEdges = shopifyProduct?.variants?.edges || [];
  const variants = variantsEdges
    .map((e) => e?.node)
    .filter(Boolean)
    .map((v) => ({
      sku: v.sku ?? null,
      price: v.price != null ? String(v.price) : null,
      stock: v.inventoryQuantity != null ? String(v.inventoryQuantity) : null,
      // We don't have explicit weight in this query; keep title (often "360 г.") which our UI already understands.
      weight: v.title != null ? String(v.title) : null,
      barcode: v.barcode ?? null,
      inventory_policy: v.inventoryPolicy ?? null,
      shopify_variant_id: v.id
    }));

  return {
    name: shopifyProduct?.title ?? '',
    handle: shopifyProduct?.handle ?? '',
    vendor: shopifyProduct?.vendor ?? '',
    variants,
    'Image url': shopifyProduct?.featuredImage?.url ?? null,
    description: shopifyProduct?.description ?? '',
    product_type: shopifyProduct?.productType ?? '',
    'Product Status': shopifyProduct?.status ?? '',
    shopify_product_id: shopifyProduct?.id ?? null
  };
}

function keyOfRow(r) {
  const gid = r?.shopify_product_id;
  return gid ? String(gid) : r?.handle ? String(r.handle) : null;
}

function diffRows(prev, next) {
  const prevMap = new Map();
  const nextMap = new Map();
  for (const r of prev) {
    const k = keyOfRow(r);
    if (k) prevMap.set(k, r);
  }
  for (const r of next) {
    const k = keyOfRow(r);
    if (k) nextMap.set(k, r);
  }

  const added = [];
  const removed = [];
  const updated = [];

  for (const [k, n] of nextMap) {
    const p = prevMap.get(k);
    if (!p) {
      added.push({ key: k, handle: n.handle, name: n.name, status: n['Product Status'] });
      continue;
    }
    // Minimal meaningful diff: status, image, variant list (price/stock/weight)
    const changes = [];
    const pushIf = (field, a, b) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(field);
    };
    pushIf('Product Status', p['Product Status'], n['Product Status']);
    pushIf('Image url', p['Image url'], n['Image url']);
    pushIf(
      'variants',
      (p.variants || []).map((v) => ({ id: v.shopify_variant_id, price: v.price, stock: v.stock, weight: v.weight })),
      (n.variants || []).map((v) => ({ id: v.shopify_variant_id, price: v.price, stock: v.stock, weight: v.weight }))
    );
    if (changes.length) updated.push({ key: k, handle: n.handle, name: n.name, changed: changes });
  }
  for (const [k, p] of prevMap) {
    if (!nextMap.has(k)) removed.push({ key: k, handle: p.handle, name: p.name, status: p['Product Status'] });
  }

  return { added, removed, updated };
}

/** Same as `npm run sync:gastronom`; safe to call from review-server (writes Output/from_gastronom.json). */
async function runSyncGastronomFromShopify() {
  const vendor = (process.env.VENDOR || 'Caviar N1').trim();
  console.log(`Syncing Shopify vendor: ${vendor}`);
  console.log(`Shop: ${shopDomain()} (API ${apiVersion()})`);

  const prev = readJsonIfExists(OUT_PATH, []);
  const prevArr = Array.isArray(prev) ? prev : [];

  const token = await getAccessToken();
  const products = await fetchAllVendorProducts(token, vendor);
  const nextArr = products.map(normalizeToGastronomFileShape);

  if (fs.existsSync(OUT_PATH)) {
    fs.copyFileSync(OUT_PATH, `${OUT_PATH}.bak`);
  }

  writeJson(OUT_PATH, nextArr);

  const delta = diffRows(prevArr, nextArr);
  writeJson(DELTA_OUT_PATH, {
    synced_at: nowIso(),
    vendor,
    counts: { total: nextArr.length, added: delta.added.length, removed: delta.removed.length, updated: delta.updated.length },
    delta
  });

  console.log(`Wrote: ${OUT_PATH} (${nextArr.length} products)`);
  console.log(`Delta: +${delta.added.length} ~${delta.updated.length} -${delta.removed.length}`);
  console.log(`Wrote: ${DELTA_OUT_PATH}`);

  return {
    ok: true,
    vendor,
    shop: shopDomain(),
    products: nextArr.length,
    delta_counts: {
      added: delta.added.length,
      updated: delta.updated.length,
      removed: delta.removed.length
    },
    paths: { from_gastronom: OUT_PATH, delta: DELTA_OUT_PATH }
  };
}

async function main() {
  await runSyncGastronomFromShopify();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Shopify sync failed:', e?.message || e);
    process.exit(1);
  });
}

module.exports = { normalizeToGastronomFileShape, runSyncGastronomFromShopify };
