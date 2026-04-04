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

/**
 * getAccessToken()
 * POST https://{SHOP}.myshopify.com/admin/oauth/access_token
 * Body: { grant_type: 'client_credentials', client_id, client_secret }
 * Returns: access_token string
 */
async function getAccessToken() {
  const url = `${shopBaseUrl()}/admin/oauth/access_token`;
  const client_id = requireEnv('CLIENT_ID').trim();
  const client_secret = requireEnv('CLIENT_SECRET').trim();

  const json = await postJson(url, {}, { grant_type: 'client_credentials', client_id, client_secret });

  const token = json && (json.access_token || json['access_token']);
  if (!token) throw new Error(`No access_token in response: ${JSON.stringify(json)}`);
  return token;
}

/**
 * getProducts(token)
 * POST https://{SHOP}.myshopify.com/admin/api/{API_VERSION}/graphql.json
 * Headers: X-Shopify-Access-Token
 */
async function getProducts(token) {
  if (!token) throw new Error('Missing token');
  const url = `${shopBaseUrl()}/admin/api/${apiVersion()}/graphql.json`;
  const query = `
    query {
      products(first: 100, query: "vendor:'Caviar N1'") {
        edges {
          node {
            id
            title
            status
            vendor
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price
                  sku
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `;

  const json = await postJson(
    url,
    { 'X-Shopify-Access-Token': token },
    { query }
  );

  const gqlErrors = json && json.errors;
  if (Array.isArray(gqlErrors) && gqlErrors.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(gqlErrors)}`);
  }
  const edges = json?.data?.products?.edges;
  return Array.isArray(edges) ? edges.map((e) => e?.node).filter(Boolean) : [];
}

module.exports = { getAccessToken, getProducts };

