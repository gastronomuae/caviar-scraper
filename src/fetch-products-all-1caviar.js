const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = 'https://1-caviar.ae';
const LIMIT = 250;
// Staging workflow: scraper writes "latest" and dashboard uses staged products_all.json.
const OUT = path.join(__dirname, '../Output/products_all.latest.json');

/** Only these Shopify collection handles are fetched (edit to add/remove). Site: /collections/{handle}/products.json */
const COLLECTION_HANDLES = ['caviar', 'seafood'];

/**
 * Optional: scrape visible limited stock quantity from product HTML.
 * Enabled by default; set SUPPLIER_HTML_QTY=0 to disable.
 *
 * This is slower (extra requests per variant), but the public Shopify JSON endpoints
 * often do not expose inventory_quantity.
 */
const HTML_QTY_ENABLED = process.env.SUPPLIER_HTML_QTY !== '0';
const HTML_QTY_CONCURRENCY = Math.max(1, Number(process.env.SUPPLIER_HTML_QTY_CONCURRENCY || '8'));
const PRODUCT_JS_QTY_ENABLED = process.env.SUPPLIER_PRODUCT_JS_QTY !== '0';

/** @type {Map<string, Promise<Map<number, number>>>} */
const productQtyMapCache = new Map();

async function fetchVariantQtyMapFromProductJs(productHandle) {
  if (!PRODUCT_JS_QTY_ENABLED) return new Map();
  const key = String(productHandle || '').trim();
  if (!key) return new Map();
  if (productQtyMapCache.has(key)) return productQtyMapCache.get(key);

  const p = (async () => {
    const url = `${BASE}/products/${key}.js`;
    const { data } = await axios.get(url, {
      timeout: 60000,
      headers: { Accept: 'application/json' }
    });
    const arr = Array.isArray(data?.variants) ? data.variants : [];
    const out = new Map();
    for (const v of arr) {
      const id = Number(v?.id);
      const q = Number(v?.inventory_quantity);
      if (Number.isFinite(id) && Number.isFinite(q)) out.set(id, q);
    }
    return out;
  })().catch(() => new Map());

  productQtyMapCache.set(key, p);
  return p;
}

async function scrapeVariantQtyFromHtml(productHandle, variantId) {
  if (!HTML_QTY_ENABLED) return null;
  const url = `${BASE}/products/${productHandle}?variant=${variantId}`;
  const { data } = await axios.get(url, {
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    responseType: 'text',
    transformResponse: (x) => x
  });
  const html = String(data || '');
  // Example snippet:
  // <div class="product-inventory-notice--text"> ... 12 in stock, ready to ship ...</div>
  const m = html.match(/(\d+)\s+in\s+stock\b/i);
  if (m) return Number(m[1]);
  return null;
}

async function mapVariantsWithHtmlQty(productHandle, variants) {
  const out = [];
  const vArr = Array.isArray(variants) ? variants : [];
  const productJsQtyMap = await fetchVariantQtyMapFromProductJs(productHandle);

  let i = 0;
  const workers = new Array(Math.min(HTML_QTY_CONCURRENCY, vArr.length)).fill(0).map(async () => {
    for (;;) {
      const idx = i++;
      if (idx >= vArr.length) return;
      const v = vArr[idx];
      const base = mapVariant(productHandle, v);
      if (base.qty == null && base.available === true) {
        const productJsQty = productJsQtyMap.get(Number(v?.id));
        if (Number.isFinite(productJsQty)) {
          const q = Math.max(0, Math.trunc(productJsQty));
          base.qty = q;
          base.unlimited_stock = false;
          base.limited_stock = q > 0 && q <= 5;
          base.out_of_stock = q <= 0;
          base.available = q > 0 || v?.inventory_policy === 'continue';
          out[idx] = base;
          continue;
        }
        try {
          const q = await scrapeVariantQtyFromHtml(productHandle, v.id);
          if (Number.isFinite(q)) {
            base.qty = q;
            base.unlimited_stock = false;
            base.limited_stock = q > 0 && q <= 5;
            base.out_of_stock = q <= 0;
          }
        } catch (_) {
          // ignore; keep base values
        }
      }
      out[idx] = base;
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

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
  // Variants are mapped async if HTML qty scrape enabled.
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
  if (!HTML_QTY_ENABLED) return raw.map(mapProduct);
  const out = [];
  for (const p of raw) {
    const base = mapProduct(p);
    base.variants = await mapVariantsWithHtmlQty(p.handle, p.variants || []);
    const firstVariant = base.variants[0] || null;
    base.regular_price = firstVariant ? firstVariant.regular_price : null;
    base.promotional_price = firstVariant ? firstVariant.promotional_price : null;
    out.push(base);
  }
  return out;
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
