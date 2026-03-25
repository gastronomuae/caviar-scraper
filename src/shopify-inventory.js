const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOKEN_CACHE_PATH = path.join(ROOT, 'Output/shopify_token_cache.json');
const LOCATION_CACHE_PATH = path.join(ROOT, 'Output/shopify_location_cache.json');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function shopDomain() {
  const raw = requireEnv('SHOP').trim();
  return raw.endsWith('.myshopify.com') ? raw : `${raw}.myshopify.com`;
}

function apiVersion() {
  return (process.env.API_VERSION || '2024-01').trim();
}

function nowIso() {
  return new Date().toISOString();
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

function tokenCacheValid(cache) {
  if (!cache || typeof cache !== 'object') return false;
  const token = cache.access_token;
  const expires_at = cache.expires_at;
  if (!token || !expires_at) return false;
  const expMs = Date.parse(expires_at);
  if (!Number.isFinite(expMs)) return false;
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
    { grant_type: 'client_credentials', client_id, client_secret },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );

  const token = data && data.access_token;
  if (!token) throw new Error(`No access_token in response: ${JSON.stringify(data)}`);

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

function normalizeLocationName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function getLocationIdByName(token, locationName) {
  const wanted = normalizeLocationName(locationName);
  if (!wanted) throw new Error('Missing locationName');

  const cached = readJsonIfExists(LOCATION_CACHE_PATH, null);
  if (cached && normalizeLocationName(cached.location_name) === wanted && cached.location_id) {
    return cached.location_id;
  }

  /** @type {{ id: string, name?: string }[]} */
  let nodes = [];
  try {
    const data = await graphql(
      token,
      `query Locations($first: Int!) {
        locations(first: $first) {
          edges { node { id name } }
        }
      }`,
      { first: 50 }
    );
    const edges = data?.locations?.edges || [];
    nodes = edges.map((e) => e?.node).filter(Boolean);
  } catch (e) {
    // Some tokens can query locations but cannot read the `name` field.
    const msg = String(e?.message || e);
    if (!msg.includes('Access denied') && !msg.includes('ACCESS_DENIED')) throw e;
    const data = await graphql(
      token,
      `query LocationsIds($first: Int!) {
        locations(first: $first) {
          edges { node { id } }
        }
      }`,
      { first: 50 }
    );
    const edges = data?.locations?.edges || [];
    nodes = edges.map((e) => e?.node).filter(Boolean);
  }

  const exact =
    nodes.find((n) => n?.name && normalizeLocationName(n.name) === wanted) || null;
  const chosen = exact || nodes[0] || null;
  if (!chosen?.id) {
    throw new Error(`No Shopify locations found. Check API token permissions.`);
  }

  writeJson(LOCATION_CACHE_PATH, {
    location_name: chosen.name || locationName,
    location_id: chosen.id,
    cached_at: nowIso()
  });
  return chosen.id;
}

async function getInventoryItemIdForVariant(token, variantId) {
  const data = await graphql(
    token,
    `query VariantInventoryItem($id: ID!) {
      productVariant(id: $id) {
        id
        title
        inventoryItem { id }
      }
    }`,
    { id: variantId }
  );
  const itemId = data?.productVariant?.inventoryItem?.id || null;
  if (!itemId) {
    throw new Error(`Could not find inventoryItem for variant: ${variantId}`);
  }
  return itemId;
}

async function getProductIdForVariant(token, variantId) {
  const data = await graphql(
    token,
    `query VariantProduct($id: ID!) {
      productVariant(id: $id) {
        id
        product { id }
      }
    }`,
    { id: variantId }
  );
  const pid = data?.productVariant?.product?.id || null;
  if (!pid) {
    throw new Error(`Could not resolve product for variant: ${variantId}`);
  }
  return pid;
}

/** Uses productVariantsBulkUpdate (productVariantUpdate is not available on all API versions). */
async function setVariantInventoryPolicy({ variantId, inventoryPolicy }) {
  const token = await getAccessToken();
  const p = String(inventoryPolicy || '').toUpperCase();
  if (p !== 'CONTINUE' && p !== 'DENY') {
    throw new Error('inventoryPolicy must be CONTINUE or DENY');
  }

  const vid = String(variantId).trim();
  const productId = await getProductIdForVariant(token, vid);

  const data = await graphql(
    token,
    `mutation PVBulkPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id inventoryPolicy }
        userErrors { field message }
      }
    }`,
    {
      productId,
      variants: [{ id: vid, inventoryPolicy: p }]
    }
  );

  const ues = data?.productVariantsBulkUpdate?.userErrors || [];
  if (Array.isArray(ues) && ues.length) {
    throw new Error(`productVariantsBulkUpdate: ${JSON.stringify(ues)}`);
  }
  return (data?.productVariantsBulkUpdate?.productVariants || [])[0] || null;
}

async function setAvailableQuantity({ variantId, locationId, quantity, reason, referenceDocumentUri }) {
  const token = await getAccessToken();
  const inventoryItemId = await getInventoryItemIdForVariant(token, variantId);

  const input = {
    name: 'available',
    reason: reason || 'correction',
    referenceDocumentUri: referenceDocumentUri || 'caviar-scraper://review-ui/inventory-sync',
    ignoreCompareQuantity: true,
    quantities: [
      {
        inventoryItemId,
        locationId,
        quantity
      }
    ]
  };

  const data = await graphql(
    token,
    `mutation InventorySet($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
          reason
          referenceDocumentUri
          changes {
            name
            delta
            quantityAfterChange
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    { input }
  );

  const payload = data?.inventorySetQuantities;
  const userErrors = payload?.userErrors || [];
  if (Array.isArray(userErrors) && userErrors.length) {
    throw new Error(`Shopify inventory error: ${JSON.stringify(userErrors)}`);
  }
  return payload?.inventoryAdjustmentGroup || null;
}

async function setProductStatus(productId, status) {
  const token = await getAccessToken();
  const s = String(status || '').toUpperCase();
  if (!['DRAFT', 'ACTIVE', 'ARCHIVED', 'UNLISTED'].includes(s)) {
    throw new Error(`Invalid product status: ${status}`);
  }
  const id = String(productId).trim();
  // Dedicated status mutation (requires same scope as productUpdate: write_products).
  const data = await graphql(
    token,
    `mutation ProductChangeStatus($productId: ID!, $status: ProductStatus!) {
      productChangeStatus(productId: $productId, status: $status) {
        product { id status }
        userErrors { field message }
      }
    }`,
    { productId: id, status: s }
  );
  const ues = data?.productChangeStatus?.userErrors || [];
  if (Array.isArray(ues) && ues.length) {
    throw new Error(`productChangeStatus: ${JSON.stringify(ues)}`);
  }
  const product = data?.productChangeStatus?.product;
  if (!product?.id) {
    throw new Error('productChangeStatus returned no product (check write_products scope and product id)');
  }
  const got = String(product.status || '')
    .trim()
    .toUpperCase();
  if (got !== s) {
    throw new Error(`productChangeStatus: expected status ${s}, Shopify returned ${got || '(empty)'}`);
  }
  return product;
}

module.exports = {
  getAccessToken,
  graphql,
  getLocationIdByName,
  getInventoryItemIdForVariant,
  setVariantInventoryPolicy,
  setAvailableQuantity,
  setProductStatus
};

