const fs = require('fs');
const path = require('path');

const INPUT_PATH = path.join(__dirname, '../Output/from_gastronom.json');
const OUTPUT_PATH = path.join(__dirname, '../Output/from_gastronom.normalized.json');

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeVariantId(raw) {
  if (!raw) return null;
  const value = String(raw);
  const match = value.match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function normalizeWeightToGrams(rawWeight) {
  if (!rawWeight) return null;
  return toNumber(rawWeight);
}

function normalizeProducts(products) {
  return products.map((product) => {
    const variant = Array.isArray(product.variants) ? product.variants[0] || {} : {};

    return {
      name: product.name || null,
      handle: product.handle || null,
      vendor: product.vendor || null,
      description: product.description || null,
      image_url: product['Image url'] || null,
      product_type: product.product_type || null,
      product_status: product['Product Status'] || null,
      shopify_product_id: product.shopify_product_id || null,
      normalized: {
        price: toNumber(variant.price),
        compare_at_price: toNumber(variant.compare_at_price),
        variant_id: normalizeVariantId(variant.shopify_variant_id),
        variant_id_raw: variant.shopify_variant_id || null,
        variant_weight: normalizeWeightToGrams(variant.weight),
        variant_stock: toNumber(variant.stock)
      }
    };
  });
}

function main() {
  const raw = fs.readFileSync(INPUT_PATH, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : [data];
  const normalized = normalizeProducts(list);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(normalized, null, 2));
  console.log(`Normalized ${normalized.length} products`);
  console.log(`Saved: ${OUTPUT_PATH}`);
}

main();
