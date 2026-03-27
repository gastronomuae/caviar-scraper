const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = 'https://ubazar.ae';
const OUT = path.join(__dirname, '..', 'Output', 'ubazar_products.latest.json');
const OUT_DELTA = path.join(__dirname, '..', 'Output', 'ubazar_delta.latest.json');
const MAPPING_PATH = path.join(__dirname, '..', 'Output', 'ubazar_product_mapping.json');
const CATEGORY_INDEX_PATH = path.join(__dirname, '..', 'Output', 'ubazar_category_index.latest.json');

function readJsonIfExistsSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absUrl(href) {
  try {
    return new URL(href, BASE).toString();
  } catch (_) {
    return null;
  }
}

async function fetchText(url) {
  const { data } = await axios.get(url, {
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    responseType: 'text',
    transformResponse: (x) => x
  });
  return String(data || '');
}

function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = absUrl(m[1]);
    if (u) out.push(u);
  }
  return [...new Set(out)];
}

function chooseMainCategory(links) {
  const candidates = links.filter((u) => /\/categories\//i.test(u));
  const scored = candidates
    .map((u) => {
      const l = u.toLowerCase();
      let score = 0;
      if (/ovoschi-i-frukty|vegetables-and-fruits/.test(l)) score += 10;
      if (/ovoschi-i-zelen|vegetables-and-herbs/.test(l)) score += 10;
      if (/овощ|фрукт/.test(decodeURIComponent(l))) score += 8;
      if (/categories\/[^/]+-\d+/.test(l)) score += 1;
      return { u, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.u || null;
}

function chooseTargetSubcategories(links) {
  const cats = links.filter((u) => /\/categories\//i.test(u));
  const target = [];
  for (const u of cats) {
    const l = u.toLowerCase();
    if (/vegetables-and-herbs|fruits-/.test(l)) target.push(u);
    if (/ovoschi-i-zelen/.test(l)) target.push(u);
    const d = decodeURIComponent(l);
    if (/овощи-и-зелень|фрукты/.test(d)) target.push(u);
  }
  return [...new Set(target)];
}

function extractProductLinks(html) {
  const links = extractLinks(html);
  return links.filter((u) => /\/products\//i.test(u));
}

function parsePrices(text) {
  const matches = String(text || '').match(/\d+(?:\.\d{1,2})?\s*AED/gi) || [];
  const nums = matches
    .map((x) => Number(String(x).replace(/\s*AED/i, '').trim()))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return { price: null, old_price: null };
  if (nums.length === 1) {
    const p = nums[0] > 0 ? nums[0] : null;
    return { price: p, old_price: null };
  }
  const price = nums[nums.length - 1] > 0 ? nums[nums.length - 1] : null;
  const old = nums[0] > 0 ? nums[0] : null;
  return { price, old_price: old };
}

function parseProductFromPage(url, html) {
  const titleMatch =
    html.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i) ||
    html.match(/<title[^>]*>\s*([^<]+?)\s*(?:-|<\/title)/i);
  const title = stripHtml(titleMatch ? titleMatch[1] : '');

  const imgMatch =
    html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
    html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  const image = imgMatch ? absUrl(imgMatch[1]) : null;

  const text = stripHtml(html);
  const prices = parsePrices(text);
  const unavailable = /нет\s+в\s+наличии|out\s+of\s+stock/i.test(text);
  const addToCart = /add\s+to\s+cart|в\s+корзину/i.test(text);
  const available = unavailable ? false : addToCart ? true : null;

  const slug = (() => {
    try {
      const p = new URL(url).pathname;
      const m = p.match(/\/products\/([^/?#]+)/i);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  })();

  return {
    name: title,
    url,
    handle: slug,
    image,
    regular_price: prices.old_price,
    promotional_price: prices.price,
    available
  };
}

function parseProductCardsFromCategoryHtml(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']*\/products\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = absUrl(m[1]);
    if (!url) continue;
    const anchorHtml = String(m[2] || '');
    const anchorInner = stripHtml(anchorHtml);
    const handleMatch = url.match(/\/products\/([^/?#]+)/i);
    const handle = handleMatch ? handleMatch[1] : null;

    // Use nearby chunk around the anchor to pick price from product card context.
    const from = Math.max(0, m.index - 120);
    const to = Math.min(html.length, m.index + 1200);
    const chunk = stripHtml(html.slice(from, to));
    const prices = parsePrices(chunk);
    // Card-level structured price spans are more reliable for regular/promotional split.
    const cardNums = [
      ...(anchorHtml.matchAll(/price--old-price[^>]*>\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)),
      ...(anchorHtml.matchAll(/price--price[^>]*>\s*([0-9]+(?:\.[0-9]{1,2})?)/gi))
    ]
      .map((x) => Number(x[1]))
      .filter((n) => Number.isFinite(n) && n > 0);
    let regularPrice = prices.old_price;
    let promoPrice = prices.price;
    if (cardNums.length >= 2) {
      regularPrice = cardNums[0];
      promoPrice = cardNums[cardNums.length - 1];
    } else if (cardNums.length === 1) {
      promoPrice = cardNums[0];
      regularPrice = null;
    }

    // Name from anchor first, fallback by handle prettified.
    let name = anchorInner;
    if (!name && handle) name = handle.replace(/-\d+$/, '').replace(/-/g, ' ');
    if (!name) continue;

    const imgMatch =
      anchorHtml.match(/<img[^>]+(?:data-src|data-original|src)=["']([^"']+)["'][^>]*>/i) ||
      html.slice(from, to).match(/<img[^>]+(?:data-src|data-original|src)=["']([^"']+)["'][^>]*>/i) ||
      null;
    const image = imgMatch ? absUrl(imgMatch[1]) : null;

    out.push({
      name,
      url,
      handle,
      image,
      regular_price: regularPrice,
      promotional_price: promoPrice
    });
  }

  // Deduplicate by handle/url and keep more informative row (with price).
  const map = new Map();
  for (const r of out) {
    const k = r.handle || r.url;
    if (!k) continue;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, r);
      continue;
    }
    const prevScore = (prev.promotional_price != null ? 1 : 0) + (prev.regular_price != null ? 1 : 0);
    const nextScore = (r.promotional_price != null ? 1 : 0) + (r.regular_price != null ? 1 : 0);
    if (nextScore > prevScore) map.set(k, r);
  }
  return [...map.values()];
}

function keyByHandleOrUrl(row) {
  return row?.handle ? `h:${row.handle}` : row?.url ? `u:${row.url}` : null;
}

function diffRows(prev, next) {
  const a = new Map();
  const b = new Map();
  for (const r of prev || []) {
    const k = keyByHandleOrUrl(r);
    if (k) a.set(k, r);
  }
  for (const r of next || []) {
    const k = keyByHandleOrUrl(r);
    if (k) b.set(k, r);
  }
  const added = [];
  const removed = [];
  const updated = [];
  for (const [k, n] of b) {
    const p = a.get(k);
    if (!p) {
      added.push({ key: k, handle: n.handle || null, name: n.name || '' });
      continue;
    }
    const changed = [];
    const pushIf = (field, x, y) => {
      if (JSON.stringify(x) !== JSON.stringify(y)) changed.push(field);
    };
    pushIf('promotional_price', p.promotional_price, n.promotional_price);
    pushIf('regular_price', p.regular_price, n.regular_price);
    pushIf('available', p.available, n.available);
    pushIf('name', p.name, n.name);
    if (changed.length) updated.push({ key: k, handle: n.handle || null, name: n.name || '', changed });
  }
  for (const [k, p] of a) {
    if (!b.has(k)) removed.push({ key: k, handle: p.handle || null, name: p.name || '' });
  }
  return { added, removed, updated };
}

function readJsonIfExists(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function discoverCategoryUrls() {
  let homeLinks = [];
  try {
    const home = await fetchText(`${BASE}/`);
    homeLinks = extractLinks(home);
  } catch (_) {
    homeLinks = [];
  }

  let mainCategory = chooseMainCategory(homeLinks);
  if (!mainCategory) {
    // Fallback to known paths if discovery from homepage fails.
    const guesses = [
      `${BASE}/categories/ovoschi-i-frukty-4`,
      `${BASE}/categories/ovoschi-i-zelen-30`,
      `${BASE}/categories/vegetables-and-fruits-4`
    ];
    mainCategory = guesses[0];
  }
  if (!mainCategory) throw new Error('Could not discover UBazar vegetables/fruits main category URL.');

  const mainHtml = await fetchText(mainCategory);
  const mainLinks = extractLinks(mainHtml);
  const subs = chooseTargetSubcategories(mainLinks);

  const finalSubs = subs.length
    ? subs
    : [
        `${BASE}/categories/ovoschi-i-zelen-30`,
        `${BASE}/categories/vegetables-and-herbs-30`,
        `${BASE}/categories/fruits-32`
      ];

  const discovered = { mainCategory, subcategories: [...new Set(finalSubs)] };
  try {
    fs.mkdirSync(path.dirname(CATEGORY_INDEX_PATH), { recursive: true });
    fs.writeFileSync(
      CATEGORY_INDEX_PATH,
      JSON.stringify(
        {
          scraped_at: new Date().toISOString(),
          source: BASE,
          discovered_from_homepage: homeLinks.filter((u) => /\/categories\//i.test(u)).slice(0, 300),
          discovered
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (_) {
    // best-effort
  }
  return discovered;
}

async function fetchAllProducts() {
  const discovered = await discoverCategoryUrls();
  const productsByKey = new Map();

  for (const cat of discovered.subcategories) {
    try {
      const html = await fetchText(cat);
      for (const r of parseProductCardsFromCategoryHtml(html)) {
        const k = r.handle || r.url;
        if (!k) continue;
        const prev = productsByKey.get(k);
        if (!prev) productsByKey.set(k, r);
        else {
          productsByKey.set(k, {
            ...prev,
            name: prev.name || r.name,
            image: prev.image || r.image || null,
            regular_price: prev.regular_price != null ? prev.regular_price : r.regular_price,
            promotional_price: prev.promotional_price != null ? prev.promotional_price : r.promotional_price
          });
        }
      }
      // Handle simple pagination: try page 2..5 if exists.
      for (let i = 2; i <= 5; i++) {
        const paged = `${cat}${cat.includes('?') ? '&' : '?'}page=${i}`;
        const h2 = await fetchText(paged).catch(() => '');
        if (!h2) break;
        const rows = parseProductCardsFromCategoryHtml(h2);
        if (!rows.length) break;
        for (const r of rows) {
          const k = r.handle || r.url;
          if (!k) continue;
          const prev = productsByKey.get(k);
          if (!prev) productsByKey.set(k, r);
        }
      }
    } catch (_) {
      // Continue if one category link is stale.
    }
  }

  const products = [];
  const rows = [...productsByKey.values()];
  for (const r of rows) {
    try {
      const html = await fetchText(r.url);
      const p = parseProductFromPage(r.url, html);
      products.push({
        ...r,
        name: p.name || r.name,
        image: p.image || r.image || null,
        // Keep card price if present; fallback to page-parsed.
        regular_price: r.regular_price != null ? r.regular_price : p.regular_price,
        promotional_price: r.promotional_price != null ? r.promotional_price : p.promotional_price,
        available: p.available
      });
    } catch (_) {
      // Keep row from category even if product page failed.
      products.push({ ...r, image: r.image || null, available: null });
    }
  }

  // Deduplicate by handle, keep first.
  const byHandle = new Map();
  for (const p of products) {
    const k = p.handle || p.url;
    if (!k) continue;
    if (!byHandle.has(k)) byHandle.set(k, p);
  }

  // If a supplier handle is mapped but missing from category discovery, fetch it directly.
  const mapping = readJsonIfExistsSafe(MAPPING_PATH, {});
  const mappedSupplierHandles = Object.keys(mapping || {}).map((h) => String(h || '').trim()).filter(Boolean);
  for (const h of mappedSupplierHandles) {
    if (byHandle.has(h)) continue;
    const url = `${BASE}/products/${encodeURIComponent(h)}`;
    try {
      const html = await fetchText(url);
      const p = parseProductFromPage(url, html);
      if (p?.handle) {
        byHandle.set(p.handle, p);
      }
    } catch (_) {
      // Ignore missing/removed products.
    }
  }

  return {
    discovered,
    products: [...byHandle.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
  };
}

async function main() {
  const { discovered, products } = await fetchAllProducts();

  const prev = readJsonIfExists(OUT, []);
  const prevArr = Array.isArray(prev) ? prev : [];

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(products, null, 2), 'utf8');

  const delta = diffRows(prevArr, products);
  fs.writeFileSync(
    OUT_DELTA,
    JSON.stringify(
      {
        scraped_at: new Date().toISOString(),
        source: BASE,
        discovered,
        counts: { total: products.length, added: delta.added.length, removed: delta.removed.length, updated: delta.updated.length },
        delta
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`UBazar: saved ${products.length} products -> ${OUT}`);
  console.log(`UBazar delta: +${delta.added.length} ~${delta.updated.length} -${delta.removed.length} -> ${OUT_DELTA}`);
}

module.exports = { fetchAllProducts, discoverCategoryUrls, parseProductFromPage };

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e.message || e));
    process.exit(1);
  });
}

