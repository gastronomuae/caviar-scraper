const fs = require('fs');
const path = require('path');

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function shopBaseUrl() {
  const shop = requireEnv('SHOP').trim();
  return `https://${shop}.myshopify.com`;
}

function apiVersion() {
  return (process.env.API_VERSION || '2025-10').trim();
}

async function postJson(url, headers, bodyObj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(bodyObj)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    // ignore
  }
  if (!res.ok) {
    const msg = json ? JSON.stringify(json) : text;
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${msg}`);
  }
  return json;
}

async function getAccessToken() {
  const url = `${shopBaseUrl()}/admin/oauth/access_token`;
  const client_id = requireEnv('CLIENT_ID').trim();
  const client_secret = requireEnv('CLIENT_SECRET').trim();
  const json = await postJson(url, {}, { grant_type: 'client_credentials', client_id, client_secret });
  const token = json && (json.access_token || json['access_token']);
  if (!token) throw new Error(`No access_token in response: ${JSON.stringify(json)}`);
  return token;
}

async function graphql(token, query, variables) {
  const url = `${shopBaseUrl()}/admin/api/${apiVersion()}/graphql.json`;
  const json = await postJson(url, { 'X-Shopify-Access-Token': token }, { query, variables });
  if (Array.isArray(json?.errors) && json.errors.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json?.data;
}

async function fetchAllVendorProducts(token, vendorQuery) {
  const all = [];
  let after = null;
  for (;;) {
    const data = await graphql(
      token,
      `query($q: String!, $after: String) {
        products(first: 250, query: $q, after: $after) {
          pageInfo { hasNextPage }
          edges { cursor node { id title status vendor handle } }
        }
      }`,
      { q: vendorQuery, after }
    );
    const edges = data?.products?.edges || [];
    for (const e of edges) all.push(e.node);
    const hasNext = Boolean(data?.products?.pageInfo?.hasNextPage);
    if (!hasNext) break;
    after = edges.length ? edges[edges.length - 1].cursor : null;
    if (!after) break;
  }
  return all;
}

function loadFromGastronom() {
  const root = path.join(__dirname, '..', '..');
  const p = path.join(root, 'Output', 'from_gastronom.json');
  if (!fs.existsSync(p)) return { path: p, list: [] };
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : [];
  return { path: p, list };
}

function keyBy(list, fn) {
  const m = new Map();
  for (const x of list) {
    const k = fn(x);
    if (!k) continue;
    m.set(k, x);
  }
  return m;
}

async function main() {
  loadDotEnv(path.join(__dirname, '.env'));

  const token = await getAccessToken();
  const vendorQuery = "vendor:'Caviar N1'";
  const shopifyAll = await fetchAllVendorProducts(token, vendorQuery);

  const statusCounts = {};
  for (const p of shopifyAll) {
    const st = String(p.status || '—');
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }

  const { path: fgPath, list: fg } = loadFromGastronom();
  const fgByGid = keyBy(fg, (p) => (p && p.shopify_product_id ? String(p.shopify_product_id) : null));
  const fgByHandle = keyBy(fg, (p) => (p && p.handle ? String(p.handle) : null));

  const shopByGid = keyBy(shopifyAll, (p) => (p && p.id ? String(p.id) : null));
  const shopByHandle = keyBy(shopifyAll, (p) => (p && p.handle ? String(p.handle) : null));

  let inBothGid = 0;
  for (const k of fgByGid.keys()) if (shopByGid.has(k)) inBothGid++;

  let inBothHandle = 0;
  for (const k of fgByHandle.keys()) if (shopByHandle.has(k)) inBothHandle++;

  const fgMissingInShopByGid = [...fgByGid.keys()].filter((k) => !shopByGid.has(k));
  const fgMissingInShopByHandle = [...fgByHandle.keys()].filter((k) => !shopByHandle.has(k));

  console.log('--- Shopify vendor query ---');
  console.log('Query:', vendorQuery);
  console.log('Total products found:', shopifyAll.length);
  console.log('Status counts:', statusCounts);
  console.log('');

  console.log('--- Output/from_gastronom.json ---');
  console.log('Path:', fgPath);
  console.log('Rows:', fg.length);
  console.log('Rows with shopify_product_id:', fgByGid.size);
  console.log('Rows with handle:', fgByHandle.size);
  console.log('');

  console.log('--- Intersection ---');
  console.log('Match by GID:', inBothGid, '/', fgByGid.size);
  console.log('Match by handle:', inBothHandle, '/', fgByHandle.size);
  console.log('');

  if (fgMissingInShopByGid.length) {
    console.log('from_gastronom GIDs NOT in Shopify vendor query:', fgMissingInShopByGid.length);
    console.log('First 10:', fgMissingInShopByGid.slice(0, 10));
    console.log('');
  }
  if (fgMissingInShopByHandle.length) {
    console.log('from_gastronom handles NOT in Shopify vendor query:', fgMissingInShopByHandle.length);
    console.log('First 10:', fgMissingInShopByHandle.slice(0, 10));
    console.log('');
  }

  const shopMissingInFg = shopifyAll.filter((p) => {
    const gid = p.id;
    const h = p.handle;
    return !(gid && fgByGid.has(gid)) && !(h && fgByHandle.has(h));
  });
  console.log('Shopify vendor products NOT present in from_gastronom (by GID or handle):', shopMissingInFg.length);
  console.log('First 10:', shopMissingInFg.slice(0, 10).map((p) => ({ title: p.title, status: p.status, handle: p.handle })));
}

main().catch((e) => {
  console.error('Compare failed:', e && e.message ? e.message : e);
  process.exit(1);
});

