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

async function main() {
  loadDotEnv(path.join(__dirname, '.env'));
  const token = await getAccessToken();
  const products = await getProducts(token);
  const counts = {};
  for (const p of products) {
    const st = String(p.status || '—');
    counts[st] = (counts[st] || 0) + 1;
  }
  console.log('Status counts:', counts);
  const nonActive = products.filter((p) => String(p.status || '').toUpperCase() !== 'ACTIVE');
  if (nonActive.length) {
    console.log('\nNon-ACTIVE products:');
    for (const p of nonActive) console.log(`- ${p.title} (${p.status})`);
  } else {
    console.log('\nAll returned products are ACTIVE.');
  }
}

main().catch((e) => {
  console.error('Status check failed:', e && e.message ? e.message : e);
  process.exit(1);
});

