const fs = require('fs');
const path = require('path');
const { getAccessToken, getProducts } = require('./shopify-client');

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

function fmtInv(qty) {
  if (qty == null) return '—';
  const n = Number(qty);
  if (!Number.isFinite(n)) return String(qty);
  return String(n);
}

async function main() {
  const envPath = path.join(__dirname, '.env');
  loadDotEnv(envPath);

  const token = await getAccessToken();
  const products = await getProducts(token);

  console.log(`Found ${products.length} products (vendor: Caviar N1)\n`);
  for (const p of products) {
    const variants = p?.variants?.edges?.map((e) => e?.node).filter(Boolean) || [];
    console.log(`Product: ${p.title}`);
    console.log(`Status: ${p.status}`);
    console.log(`Variants: ${variants.length}\n`);
    for (const v of variants) {
      console.log(`* SKU: ${v.sku || '—'} | Title: ${v.title || '—'} | Price: ${v.price || '—'} | Inventory: ${fmtInv(v.inventoryQuantity)}`);
    }
    console.log('\n---\n');
  }
}

main().catch((e) => {
  console.error('Shopify test failed:', e && e.message ? e.message : e);
  process.exit(1);
});

