/**
 * URL ↔ Handle utilities for products_all ↔ Shopify mapping
 *
 * Rules:
 * - Handle = slug from /products/{handle} (works for /collections/.../products/{handle} too)
 * - Full URL = {baseUrl}/products/{handle}
 * - Example: https://1-caviar.ae/collections/seafood/products/balik-omul-cold-smoked-fillet
 *   → handle = "balik-omul-cold-smoked-fillet"
 *   → https://www.gastronom.ae/products/balik-omul-cold-smoked-fillet
 */

const DEFAULT_SOURCE_BASE = 'https://1-caviar.ae';
const DEFAULT_TARGET_BASE = 'https://www.gastronom.ae';

/**
 * Extract Shopify handle from product URL
 * @param {string} url - e.g. "https://1-caviar.ae/collections/seafood/products/balik-omul-cold-smoked-fillet"
 * @returns {string|null} - e.g. "balik-omul-cold-smoked-fillet"
 */
function extractHandleFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/products\/([^/??#]+)/);
  return match ? match[1] : null;
}

/**
 * Build full product URL from handle
 * @param {string} handle - e.g. "balik-omul-cold-smoked-fillet"
 * @param {string} baseUrl - e.g. "https://www.gastronom.ae"
 * @returns {string} - e.g. "https://www.gastronom.ae/products/balik-omul-cold-smoked-fillet"
 */
function buildProductUrl(handle, baseUrl = DEFAULT_TARGET_BASE) {
  if (!handle) return null;
  const base = (baseUrl || '').replace(/\/$/, '');
  return `${base}/products/${handle}`;
}

/**
 * Convert source URL to target store URL
 * @param {string} sourceUrl - URL from 1-caviar.ae
 * @param {string} targetBase - base URL for target store (default: gastronom.ae)
 * @returns {string|null}
 */
function sourceUrlToTargetUrl(sourceUrl, targetBase = DEFAULT_TARGET_BASE) {
  const handle = extractHandleFromUrl(sourceUrl);
  return handle ? buildProductUrl(handle, targetBase) : null;
}

module.exports = {
  extractHandleFromUrl,
  buildProductUrl,
  sourceUrlToTargetUrl,
  DEFAULT_SOURCE_BASE,
  DEFAULT_TARGET_BASE
};
