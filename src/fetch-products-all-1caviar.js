const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = 'https://1-caviar.ae';
const LIMIT = 250;
const OUT = path.join(__dirname, '../Output/products_all.json');

/** Only these Shopify collection handles are fetched (edit to add/remove). Site: /collections/{handle}/products.json */
const COLLECTION_HANDLES = ['caviar', 'seafood'];

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return `${num.toFixed(2)} AED`;
}

function variantWeight(variant) {
  const o = variant.option1;
  if (o && o !== 'Default Title') return o;
  const t = variant.title;
  if (t && t !== 'Default Title') return t;
  if (typeof variant.grams === 'number' && variant.grams > 0) return String(variant.grams);
  return null;
}

function variantIsAvailable(variant) {
  if (typeof variant.inventory_quantity === 'number') {
    return variant.inventory_quantity > 0 || variant.inventory_policy === 'continue';
  }
  if (typeof variant.available === 'boolean') return variant.available;
  return true;
}

function mapVariant(productHandle, variant) {
  const qtyActual =
    typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity : null;
  const available = variantIsAvailable(variant);

  return {
    variant_id: variant.id,
    weight: variantWeight(variant),
    regular_price: formatPrice(variant.compare_at_price),
    promotional_price: formatPrice(variant.price),
    qty: qtyActual,
    unlimited_stock: qtyActual === null && available === true,
    out_of_stock: available === false,
    limited_stock: typeof qtyActual === 'number' ? qtyActual > 0 && qtyActual <= 5 : false,
    available,
    url: `${BASE}/products/${productHandle}?variant=${variant.id}`
  };
}

function mapProduct(product) {
  const variants = (product.variants || []).map((v) => mapVariant(product.handle, v));
  const firstVariant = variants[0] || null;
  const imageSrc =
    (product.images && product.images[0] && product.images[0].src) ||
    (product.image && product.image.src) ||
    null;

  return {
    name: product.title || '',
    description: stripHtml(product.body_html),
    image: imageSrc,
    url: `${BASE}/products/${product.handle}`,
    regular_price: firstVariant ? firstVariant.regular_price : null,
    promotional_price: firstVariant ? firstVariant.promotional_price : null,
    variants
  };
}

async function fetchCollectionPage(collectionHandle, page) {
  const { data } = await axios.get(`${BASE}/collections/${collectionHandle}/products.json`, {
    params: { limit: LIMIT, page },
    timeout: 60000,
    headers: { Accept: 'application/json' }
  });
  return (data && data.products) || [];
}

async function fetchOneCollection(collectionHandle) {
  const all = [];
  let page = 1;
  for (;;) {
    const batch = await fetchCollectionPage(collectionHandle, page);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < LIMIT) break;
    page += 1;
  }
  return all;
}

/** Union of all configured collections; deduped by Shopify product id */
async function fetchRawProducts() {
  const byId = new Map();

  for (const col of COLLECTION_HANDLES) {
    const batch = await fetchOneCollection(col);
    for (const p of batch) {
      if (p && p.id != null) byId.set(p.id, p);
    }
  }

  return [...byId.values()];
}

async function fetchAllProducts() {
  const raw = await fetchRawProducts();
  return raw.map(mapProduct);
}

async function main() {
  console.log(`Fetching collections: ${COLLECTION_HANDLES.join(', ')} …`);
  const products = await fetchAllProducts();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(products, null, 2));
  console.log(`Saved ${products.length} products to ${OUT}`);
}

module.exports = {
  BASE,
  OUT,
  fetchRawProducts,
  fetchAllProducts,
  mapProduct,
  mapVariant,
  main
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.response?.data || err.message);
    process.exit(1);
  });
}
