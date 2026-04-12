/**
 * Diagnostic script — tries all known PO/inventory-transfer endpoints
 * and logs the full URL + raw response for each.
 */

require("dotenv").config();
const axios = require("axios");

const SHOP = process.env.SHOP;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing SHOP / CLIENT_ID / CLIENT_SECRET in .env");
  process.exit(1);
}

const SHOP_ORIGIN = `https://${SHOP}.myshopify.com`;

const ENDPOINTS = [
  `${SHOP_ORIGIN}/admin/api/2024-04/purchase_orders.json?limit=1`,
  `${SHOP_ORIGIN}/admin/api/2024-01/purchase_orders.json?limit=1`,
  `${SHOP_ORIGIN}/admin/api/2024-04/inventory_transfers.json?limit=1`,
  `${SHOP_ORIGIN}/admin/api/2024-01/inventory_transfers.json?limit=1`,
  `${SHOP_ORIGIN}/admin/api/2023-04/purchase_orders.json?limit=1`,
];

async function getToken() {
  const { data } = await axios.post(
    `${SHOP_ORIGIN}/admin/oauth/access_token`,
    { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    { headers: { "Content-Type": "application/json" } }
  );
  if (!data?.access_token) throw new Error("No token in response");
  console.log(`✅  Token obtained\n`);
  return data.access_token;
}

async function tryEndpoint(url, token) {
  console.log(`\n→ GET ${url}`);
  try {
    const { status, data } = await axios.get(url, {
      headers: { "X-Shopify-Access-Token": token },
    });
    console.log(`   HTTP ${status}`);
    console.log(`   Response keys: ${Object.keys(data).join(", ")}`);
    const firstKey = Object.keys(data)[0];
    if (Array.isArray(data[firstKey])) {
      console.log(`   Records returned: ${data[firstKey].length}`);
      if (data[firstKey].length > 0) {
        console.log(`   First record keys: ${Object.keys(data[firstKey][0]).join(", ")}`);
      }
    } else {
      console.log(`   Raw: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return true;
  } catch (err) {
    const status = err.response?.status ?? "no response";
    const body = err.response?.data;
    const short = typeof body === "object" ? JSON.stringify(body) : String(body ?? err.message).slice(0, 200);
    console.log(`   HTTP ${status} — ${short}`);
    return false;
  }
}

async function main() {
  const token = await getToken();
  for (const url of ENDPOINTS) {
    await tryEndpoint(url, token);
    await new Promise(r => setTimeout(r, 400));
  }
  console.log("\n✅  Done");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
