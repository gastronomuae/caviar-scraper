/**
 * Test cost update for one specific barcode.
 * Usage: node test-cost.js <barcode> <new_cost>
 * Example: node test-cost.js 4605246017872 12.62
 */
require("dotenv").config();
const axios = require("axios");

const SHOP = process.env.SHOP;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const SHOP_ORIGIN = `https://${SHOP}.myshopify.com`;
const API_VERSION = "2024-04";
const GQL_URL = `${SHOP_ORIGIN}/admin/api/${API_VERSION}/graphql.json`;

const [,, barcode = "4605246017872", newCost = "12.62"] = process.argv;

async function getToken() {
  const { data } = await axios.post(
    `${SHOP_ORIGIN}/admin/oauth/access_token`,
    { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    { headers: { "Content-Type": "application/json" } }
  );
  return data.access_token;
}

async function gql(token, query, variables = {}) {
  const { data } = await axios.post(GQL_URL, { query, variables }, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join("; "));
  return data.data;
}

async function main() {
  const token = await getToken();
  console.log("✅ Token obtained\n");

  // 1. Find variant by barcode
  const findResult = await gql(token, `
    query { productVariants(first:1, query:"barcode:${barcode}") {
      edges { node {
        id displayName sku barcode
        inventoryItem { id unitCost { amount currencyCode } }
      }}
    }}
  `);

  const variant = findResult?.productVariants?.edges?.[0]?.node;
  if (!variant) { console.error("❌ Variant not found for barcode", barcode); return; }

  console.log("Found variant:", variant.displayName);
  console.log("Inventory item ID:", variant.inventoryItem.id);
  console.log("Current cost:", variant.inventoryItem.unitCost?.amount, variant.inventoryItem.unitCost?.currencyCode);
  console.log("\nAttempting to update cost to:", newCost, "\n");

  // 2. Update cost
  const updateResult = await gql(token, `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id unitCost { amount currencyCode } }
        userErrors { field message }
      }
    }
  `, {
    id: variant.inventoryItem.id,
    input: { cost: parseFloat(newCost).toFixed(4) },
  });

  console.log("Full mutation response:");
  console.log(JSON.stringify(updateResult, null, 2));

  const errors = updateResult.inventoryItemUpdate?.userErrors ?? [];
  if (errors.length) {
    console.error("\n❌ userErrors:", errors);
  } else {
    const after = updateResult.inventoryItemUpdate?.inventoryItem?.unitCost?.amount;
    console.log("\n✅ Cost after update:", after);
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
