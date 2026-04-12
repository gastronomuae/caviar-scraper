/**
 * po-shopify — Sync Shopify Purchase Orders from PDF exports
 *
 * Workflow:
 *   1. Read all PDFs from /pdfs folder
 *   2. Parse each PDF to extract line items (barcode, SKU, qty, cost)
 *   3. For each line item find the Shopify variant by barcode (GraphQL)
 *   4. Update inventory item cost
 *   5. Add received qty to available stock at the configured location
 *   6. Write output.csv with full results
 *
 * Set DRY_RUN=false in .env to actually apply changes.
 */

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
pdfjsLib.GlobalWorkerOptions.workerSrc = false;
const Fuse = require("fuse.js");

// ─── Config ──────────────────────────────────────────────────────────────────

const SHOP_SUBDOMAIN = process.env.SHOP;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
// Accept either plain numeric ID or full GID
const LOCATION_ID_RAW = (process.env.LOCATION_ID || "").trim();
const LOCATION_GID = LOCATION_ID_RAW.startsWith("gid://")
  ? LOCATION_ID_RAW
  : `gid://shopify/Location/${LOCATION_ID_RAW}`;

const DRY_RUN = process.env.DRY_RUN !== "false";
const API_VERSION = "2024-04";
const DELAY_MS = 500;
const FUSE_THRESHOLD = 0.1; // very strict — near-exact title matches only
const PDFS_DIR = path.join(__dirname, "pdfs");
const OUTPUT_CSV = path.join(__dirname, "output.csv");
const UNMATCHED_CSV = path.join(__dirname, "unmatched.csv");

if (!SHOP_SUBDOMAIN || !CLIENT_ID || !CLIENT_SECRET || !LOCATION_ID_RAW) {
  console.error("❌  Missing required env vars: SHOP, CLIENT_ID, CLIENT_SECRET, LOCATION_ID");
  process.exit(1);
}

if (DRY_RUN) {
  console.log("🔍  DRY_RUN=true — no changes will be written to Shopify\n");
} else {
  console.log("🚀  LIVE MODE — changes WILL be written to Shopify\n");
}

console.log(`📍  Location GID: ${LOCATION_GID}\n`);

const SHOP_ORIGIN = `https://${SHOP_SUBDOMAIN}.myshopify.com`;
const GQL_URL = `${SHOP_ORIGIN}/admin/api/${API_VERSION}/graphql.json`;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const { data } = await axios.post(
    `${SHOP_ORIGIN}/admin/oauth/access_token`,
    { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    { headers: { "Content-Type": "application/json" } }
  );
  const token = data?.access_token;
  if (!token) throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
  console.log("🔑  Access token obtained\n");
  return token;
}

let GQL_HEADERS = {};

function initHeaders(token) {
  GQL_HEADERS = {
    "X-Shopify-Access-Token": token,
    "Content-Type": "application/json",
  };
}

async function gql(query, variables = {}) {
  const { data } = await axios.post(GQL_URL, { query, variables }, { headers: GQL_HEADERS });
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join("; "));
  return data.data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── PDF Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a Shopify Purchase Order PDF.
 *
 * Shopify PO PDFs render as flat text per page. After extraction each page
 * is a single long string like:
 *
 *   "Product Name  Weight  Barcode  -  Qty  AEDcost  tax%  AEDtotal  ..."
 *
 * The supplier SKU column is always "-" (dash). The pattern per line item is:
 *   [optional 8-14 digit barcode]  -  <qty>  AED<cost>  <tax%>  AED<total>
 *
 * Items that span page breaks have the barcode at the START of the next page
 * (right after the page footer). Stripping headers/footers and joining pages
 * lets the regex find these split items correctly.
 */
function parsePOPdf(pages, filename) {
  // PO name from first page header
  let poName = path.basename(filename, ".pdf").toUpperCase();
  const poMatch = (pages[0] || "").match(/#(PO\d+)/i);
  if (poMatch) poName = poMatch[1].toUpperCase();

  // Strip page headers and footers, then join all pages
  const FOOTER_RE = /gastronom\.ae\s+#\w+\s+Powered by Shopify\s+\d+\s+of\s+\d+/gi;
  const HEADER_RE = /gastronom\.ae\s+#\w+\s+\w[\w\s,]+\d{4}/gi;

  const fullText = pages
    .map((p) => p.replace(FOOTER_RE, " ").replace(HEADER_RE, " "))
    .join(" ");

  if (process.env.DEBUG_PDF) {
    console.log(`\n──── CLEANED TEXT: ${filename} ────`);
    console.log(fullText.slice(0, 3000));
    console.log("──── END ────\n");
  }

  const items = [];

  // Each row: [barcode]  -  qty  AED<cost>  <tax%>  AED<total>
  // Barcode is 8–14 digits and optional (some products have none)
  const ITEM_RE = /(?:(\d{8,14})\s+)?-\s+(\d{1,4})\s+AED([\d.]+)\s+\d+%\s+AED[\d.,]+/g;

  // Start scanning after the column header
  let prevEnd = (() => {
    const h = fullText.indexOf("TOTAL (AED)");
    return h >= 0 ? h + "TOTAL (AED)".length : 0;
  })();

  let match;
  while ((match = ITEM_RE.exec(fullText)) !== null) {
    const barcode = match[1] || null;
    const qty = parseInt(match[2], 10);
    const unitCost = parseFloat(match[3]);

    if (unitCost <= 0 || qty <= 0 || qty > 999) {
      prevEnd = match.index + match[0].length;
      continue;
    }

    // Extract product title from text between end of previous item and start of this match
    const segment = fullText.slice(prevEnd, match.index).trim();
    const pdfTitle = segment
      // Remove trailing weight/size (e.g. "500 г.", "10 шт.", "1 кг.", "200 мл.")
      .replace(/\s+\d+[\s]*(г\.|кг\.|мл\.|шт\.|л\.?|г|кг|мл|шт|л)\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    prevEnd = match.index + match[0].length;

    items.push({ poName, barcode, sku: null, qty, unitCost, pdfTitle });
  }

  return items;
}

// ─── Shopify GraphQL operations ───────────────────────────────────────────────

const FIND_VARIANT_BY_BARCODE = `
  query findVariant($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          sku
          barcode
          displayName
          inventoryItem {
            id
            unitCost { amount currencyCode }
          }
        }
      }
    }
  }
`;

async function findVariantByBarcode(barcode) {
  const data = await gql(FIND_VARIANT_BY_BARCODE, { query: `barcode:${barcode}` });
  const edge = data?.productVariants?.edges?.[0];
  return edge ? edge.node : null;
}

async function findVariantBySku(sku) {
  const data = await gql(FIND_VARIANT_BY_BARCODE, { query: `sku:${sku}` });
  const edge = data?.productVariants?.edges?.[0];
  return edge ? edge.node : null;
}

const FIND_VARIANTS_BY_PRODUCT_TITLE = `
  query findByTitle($query: String!) {
    productVariants(first: 10, query: $query) {
      edges {
        node {
          id
          sku
          barcode
          displayName
          product { title }
          inventoryItem {
            id
            unitCost { amount currencyCode }
          }
        }
      }
    }
  }
`;

// Cache all variants fetched for title matching to avoid repeated full scans
let _allVariantsCache = null;

async function getAllVariants() {
  if (_allVariantsCache) return _allVariantsCache;

  console.log("  🔄  Fetching all product variants for title matching…");
  const ALL_VARIANTS_QUERY = `
    query allVariants($after: String) {
      productVariants(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id sku barcode displayName
            product { title }
            inventoryItem {
              id
              unitCost { amount currencyCode }
            }
          }
        }
      }
    }
  `;

  const variants = [];
  let cursor = null;
  do {
    const data = await gql(ALL_VARIANTS_QUERY, cursor ? { after: cursor } : {});
    const page = data?.productVariants;
    for (const e of page?.edges ?? []) variants.push(e.node);
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    await sleep(DELAY_MS);
  } while (cursor);

  console.log(`  ✅  Loaded ${variants.length} variants for fuzzy matching\n`);
  _allVariantsCache = variants;
  return variants;
}

async function findVariantByTitle(pdfTitle) {
  if (!pdfTitle) return null;

  const allVariants = await getAllVariants();

  const fuse = new Fuse(allVariants, {
    keys: ["product.title"],
    threshold: FUSE_THRESHOLD,
    includeScore: true,
  });

  const results = fuse.search(pdfTitle);
  if (results.length === 0) return null;

  const best = results[0];
  console.log(`    [fuse] "${pdfTitle}" → "${best.item.product.title}"  score=${best.score?.toFixed(4)}`);
  return best.item;
}

const UPDATE_COST = `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id unitCost { amount currencyCode } }
      userErrors { field message }
    }
  }
`;

async function updateCost(inventoryItemId, cost) {
  const costStr = parseFloat(cost).toFixed(4);
  const result = await gql(UPDATE_COST, {
    id: inventoryItemId,
    input: { cost: costStr },
  });
  const errors = result.inventoryItemUpdate?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  const updated = result.inventoryItemUpdate?.inventoryItem?.unitCost?.amount;
  if (updated === undefined || updated === null) {
    throw new Error(`inventoryItemUpdate returned no unitCost — response: ${JSON.stringify(result)}`);
  }
  return updated;
}

const ADJUST_QTY = `
  mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup {
        changes { name delta quantityAfterChange }
      }
    }
  }
`;

async function adjustQty(inventoryItemId, delta) {
  const result = await gql(ADJUST_QTY, {
    input: {
      reason: "received",
      name: "available",
      changes: [{ inventoryItemId, locationId: LOCATION_GID, delta }],
    },
  });
  const errors = result.inventoryAdjustQuantities?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  const change = result.inventoryAdjustQuantities?.inventoryAdjustmentGroup?.changes?.[0];
  return change?.quantityAfterChange;
}

// ─── Process one line item ────────────────────────────────────────────────────

async function processItem(item) {
  const { poName, barcode, sku, qty, unitCost, pdfTitle } = item;

  // Find variant — try barcode first, then SKU, then fuzzy title match
  let variant = null;
  let matchedBy = "barcode";
  if (barcode) {
    variant = await findVariantByBarcode(barcode);
    await sleep(DELAY_MS);
  }
  if (!variant && sku) {
    matchedBy = "sku";
    variant = await findVariantBySku(sku);
    await sleep(DELAY_MS);
  }
  if (!variant && item.pdfTitle) {
    matchedBy = "title";
    variant = await findVariantByTitle(item.pdfTitle);
    await sleep(DELAY_MS);
  }

  if (!variant) {
    console.log(`  ⚠️  [${poName}] NOT FOUND — barcode:${barcode ?? "—"}  title:"${item.pdfTitle ?? ""}"`);
    return {
      po: poName, barcode: barcode ?? "", sku: sku ?? "",
      title: item.pdfTitle ?? "", oldCost: "", newCost: unitCost, qtyAdded: qty,
      status: "UNMATCHED",
    };
  }

  const invItemId = variant.inventoryItem.id;
  const oldCost = variant.inventoryItem.unitCost?.amount ?? "";
  const title = variant.displayName;
  const resolvedSku = variant.sku || sku || "";
  const resolvedBarcode = variant.barcode || barcode || "";

  console.log(
    `  [${poName}] ${resolvedSku} | ${resolvedBarcode} | ${title}  (via ${matchedBy})\n` +
    `           cost: ${oldCost} → ${unitCost}  |  qty +${qty}`
  );

  if (DRY_RUN) {
    return {
      po: poName, barcode: resolvedBarcode, sku: resolvedSku,
      title, oldCost, newCost: unitCost, qtyAdded: qty, status: "DRY_RUN",
    };
  }

  let costStatus = "ok";
  let qtyStatus = "ok";

  try {
    await updateCost(invItemId, unitCost);
    console.log(`    ✅  Cost updated → ${unitCost}`);
  } catch (err) {
    costStatus = `cost_err: ${err.message}`;
    console.warn(`    ⚠️  Cost update failed: ${err.message}`);
  }
  await sleep(DELAY_MS);

  try {
    const newQty = await adjustQty(invItemId, qty);
    console.log(`    ✅  Qty adjusted +${qty} → available: ${newQty}`);
  } catch (err) {
    qtyStatus = `qty_err: ${err.message}`;
    console.warn(`    ⚠️  Qty adjust failed: ${err.message}`);
  }
  await sleep(DELAY_MS);

  const status = costStatus === "ok" && qtyStatus === "ok"
    ? "SUCCESS"
    : `${costStatus} | ${qtyStatus}`;

  return {
    po: poName, barcode: resolvedBarcode, sku: resolvedSku,
    title, oldCost, newCost: unitCost, qtyAdded: qty, status,
  };
}

// ─── CSV output ───────────────────────────────────────────────────────────────

function csvRow(r) {
  return [
    r.po,
    r.barcode,
    r.sku,
    `"${String(r.title).replace(/"/g, '""')}"`,
    r.oldCost,
    r.newCost,
    r.qtyAdded,
    r.status,
  ].join(",");
}

function writeCSV(rows) {
  const header = "PO,Barcode,SKU,Title,Old Cost,New Cost,Qty Added,Status";
  const lines = rows.map(csvRow);
  fs.writeFileSync(OUTPUT_CSV, [header, ...lines].join("\n"), "utf8");
  console.log(`📄  Results written to ${OUTPUT_CSV}`);
}

function writeUnmatchedCSV(rows) {
  const unmatched = rows.filter((r) => r.status === "UNMATCHED");
  if (unmatched.length === 0) return;
  const header = "PO,Barcode,SKU,PDF Title,New Cost,Qty";
  const lines = unmatched.map((r) =>
    [r.po, r.barcode, r.sku, `"${String(r.title).replace(/"/g, '""')}"`, r.newCost, r.qtyAdded].join(",")
  );
  fs.writeFileSync(UNMATCHED_CSV, [header, ...lines].join("\n"), "utf8");
  console.log(`⚠️   Unmatched items written to ${UNMATCHED_CSV}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Auth
  const token = await getAccessToken();
  initHeaders(token);

  // Read PDFs
  if (!fs.existsSync(PDFS_DIR)) {
    console.error(`❌  /pdfs folder not found at ${PDFS_DIR}`);
    console.error("    Create it and place your PO PDF files inside.");
    process.exit(1);
  }

  const pdfFiles = fs.readdirSync(PDFS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort();

  if (pdfFiles.length === 0) {
    console.error("❌  No PDF files found in /pdfs folder.");
    process.exit(1);
  }

  console.log(`📂  Found ${pdfFiles.length} PDF(s): ${pdfFiles.join(", ")}\n`);

  const allItems = [];

  for (const file of pdfFiles) {
    const filePath = path.join(PDFS_DIR, file);
    console.log(`\n━━━  Parsing: ${file}  ━━━`);

    let items = [];
    try {
      const data = new Uint8Array(fs.readFileSync(filePath));
      const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
      const pdf = await loadingTask.promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => item.str).join(" "));
      }
      items = parsePOPdf(pages, file);
      console.log(`     Extracted ${items.length} line item(s)`);
      if (items.length === 0) {
        console.warn("     ⚠️  No items extracted — set DEBUG_PDF=1 to see raw text");
      }
    } catch (err) {
      console.error(`     ❌  PDF parse error: ${err.message}`);
      continue;
    }

    for (const item of items) {
      try {
        const row = await processItem(item);
        allItems.push(row);
      } catch (err) {
        console.error(`     ❌  Error processing item: ${err.message}`);
        allItems.push({
          po: item.poName, barcode: item.barcode ?? "", sku: item.sku ?? "",
          title: "", oldCost: "", newCost: item.unitCost, qtyAdded: item.qty,
          status: `ERROR: ${err.message}`,
        });
      }
    }
  }

  // Summary
  const counts = { SUCCESS: 0, DRY_RUN: 0, UNMATCHED: 0, ERROR: 0 };
  for (const r of allItems) {
    if (r.status === "SUCCESS") counts.SUCCESS++;
    else if (r.status === "DRY_RUN") counts.DRY_RUN++;
    else if (r.status === "UNMATCHED") counts.UNMATCHED++;
    else counts.ERROR++;
  }

  console.log(
    `\n✅  Done — ${allItems.length} items total` +
    (DRY_RUN
      ? `  (${counts.DRY_RUN} dry-run, ${counts.UNMATCHED} unmatched)`
      : `  (${counts.SUCCESS} ok, ${counts.UNMATCHED} unmatched, ${counts.ERROR} errors)`)
  );
  console.log();

  writeCSV(allItems);
  writeUnmatchedCSV(allItems);
}

main().catch((err) => {
  const detail = err.response
    ? `HTTP ${err.response.status} on ${err.config?.url}: ${JSON.stringify(err.response.data)}`
    : err.message;
  console.error("Fatal error:", detail);
  process.exit(1);
});
