const {
  getAccessToken,
  graphql,
  getLocationIdByName,
  getInventoryItemIdForVariant,
  setProductStatus
} = require('./shopify-inventory');

function gramsFromSupplierVariant(v) {
  const w = v?.weight;
  if (w == null || String(w).trim() === '') return null;
  const m = String(w).match(/(-?\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function gramsFromShopifyVariant(v) {
  const so = v?.selectedOptions || [];
  for (const p of so) {
    const m = String(p?.value || '').match(/(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  const t = v?.title;
  if (t) {
    const m2 = String(t).match(/(\d+)/);
    if (m2) {
      const n = parseInt(m2[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function weightLabelRu(grams) {
  return `${grams} г.`;
}

function supplierUnitPrice(sv) {
  const raw = sv?.promotional_price != null ? sv.promotional_price : sv?.regular_price;
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Mirrors review UI: unlimited vs limited vs out of stock. */
function supplierPolicyAndQty(sv) {
  const out = Boolean(sv?.out_of_stock) || sv?.available === false;
  if (out) return { inventoryPolicy: 'DENY', quantity: 0 };
  if (sv?.unlimited_stock) return { inventoryPolicy: 'CONTINUE', quantity: 0 };
  const q = sv?.qty;
  if (q != null && String(q).trim() !== '') {
    const n = Math.trunc(Number(String(q).replace(/[^0-9-]+/g, '')));
    const qty = Number.isFinite(n) ? Math.max(0, n) : 0;
    return { inventoryPolicy: 'DENY', quantity: qty };
  }
  if (sv?.limited_stock) return { inventoryPolicy: 'DENY', quantity: 0 };
  return { inventoryPolicy: 'CONTINUE', quantity: 0 };
}

function normalizeProductFromQuery(data) {
  const p = data?.product;
  if (!p) return null;
  const options = Array.isArray(p.options) ? p.options : [];
  const edges = p?.variants?.edges || [];
  const variants = edges.map((e) => e?.node).filter(Boolean);
  return { id: p.id, title: p.title, status: p.status ?? null, options, variants };
}

/** At least one variant can be purchased: CONTINUE (sell when out of stock) or DENY with available qty &gt; 0. */
function productHasSellableVariant(product) {
  const variants = product?.variants || [];
  if (!variants.length) return false;
  for (const v of variants) {
    const policy = String(v.inventoryPolicy || '').toUpperCase();
    const qtyRaw = v.inventoryQuantity;
    const qty = qtyRaw != null && Number.isFinite(Number(qtyRaw)) ? Math.max(0, Number(qtyRaw)) : 0;
    if (policy === 'CONTINUE') return true;
    if (policy === 'DENY' && qty > 0) return true;
  }
  return false;
}

function getWeightOption(product) {
  const options = product.options || [];
  if (options.length === 0) return null;
  if (options.length === 1) return options[0];
  const vars = product.variants || [];
  let best = options[0];
  let bestScore = -1;
  for (const o of options) {
    let score = 0;
    for (const v of vars) {
      const so = (v.selectedOptions || []).find((x) => x.name === o.name);
      if (so && /\d/.test(String(so.value || ''))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

function variantMapByGrams(variants) {
  const m = new Map();
  for (const v of variants) {
    const g = gramsFromShopifyVariant(v);
    if (g == null) continue;
    if (!m.has(g)) m.set(g, v);
  }
  return m;
}

function buildVariantSyncPlan(supplierProduct, productNorm) {
  const supVars = Array.isArray(supplierProduct?.variants) ? supplierProduct.variants : [];
  const supplierByGrams = new Map();
  for (const sv of supVars) {
    const g = gramsFromSupplierVariant(sv);
    if (g == null) continue;
    supplierByGrams.set(g, sv);
  }

  const shopifyVars = productNorm?.variants || [];
  const shopifyByGrams = variantMapByGrams(shopifyVars);

  const toUpdate = [];
  const toCreate = [];
  const toZeroOut = [];

  for (const [g, sv] of supplierByGrams) {
    const shv = shopifyByGrams.get(g);
    const price = supplierUnitPrice(sv);
    const { inventoryPolicy, quantity } = supplierPolicyAndQty(sv);
    if (shv) {
      toUpdate.push({
        grams: g,
        variantId: shv.id,
        inventoryItemId: shv.inventoryItem?.id || null,
        price,
        inventoryPolicy,
        quantity
      });
    } else {
      toCreate.push({
        grams: g,
        optionLabel: weightLabelRu(g),
        price,
        inventoryPolicy,
        quantity
      });
    }
  }

  for (const [g, shv] of shopifyByGrams) {
    if (!supplierByGrams.has(g)) {
      toZeroOut.push({
        grams: g,
        variantId: shv.id,
        inventoryItemId: shv.inventoryItem?.id || null
      });
    }
  }

  return { supplierByGrams, shopifyByGrams, toUpdate, toCreate, toZeroOut };
}

async function fetchProductForSync(token, productId) {
  const data = await graphql(
    token,
    `query ProductVariantSync($id: ID!) {
      product(id: $id) {
        id
        title
        status
        options {
          id
          name
          position
          values
        }
        variants(first: 100) {
          edges {
            node {
              id
              title
              price
              inventoryQuantity
              inventoryPolicy
              inventoryItem { id }
              selectedOptions { name value }
            }
          }
        }
      }
    }`,
    { id: productId }
  );
  return normalizeProductFromQuery(data);
}

async function productOptionUpdateAddValues(token, productId, optionId, names) {
  if (!names.length) return;
  const data = await graphql(
    token,
    `mutation OptAdd($pid: ID!, $opt: OptionUpdateInput!, $add: [OptionValueCreateInput!]!) {
      productOptionUpdate(productId: $pid, option: $opt, optionValuesToAdd: $add) {
        userErrors { field message }
        product {
          id
          options {
            id
            name
            position
            values
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                inventoryQuantity
                inventoryPolicy
                inventoryItem { id }
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }`,
    {
      pid: productId,
      opt: { id: optionId },
      add: names.map((name) => ({ name }))
    }
  );
  const ues = data?.productOptionUpdate?.userErrors || [];
  if (Array.isArray(ues) && ues.length) {
    throw new Error(`productOptionUpdate: ${JSON.stringify(ues)}`);
  }
  return normalizeProductFromQuery({ product: data?.productOptionUpdate?.product });
}

async function productVariantsBulkCreateRun(token, productId, variantsInput) {
  if (!variantsInput.length) return [];
  const data = await graphql(
    token,
    `mutation PVC($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants { id title }
        userErrors { field message }
      }
    }`,
    { productId, variants: variantsInput }
  );
  const ues = data?.productVariantsBulkCreate?.userErrors || [];
  if (Array.isArray(ues) && ues.length) {
    throw new Error(`productVariantsBulkCreate: ${JSON.stringify(ues)}`);
  }
  return data?.productVariantsBulkCreate?.productVariants || [];
}

async function productVariantsBulkUpdateChunk(token, productId, variantsInput) {
  if (!variantsInput.length) return [];
  const data = await graphql(
    token,
    `mutation PVBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price inventoryPolicy }
        userErrors { field message }
      }
    }`,
    { productId, variants: variantsInput }
  );
  const ues = data?.productVariantsBulkUpdate?.userErrors || [];
  if (Array.isArray(ues) && ues.length) {
    throw new Error(`productVariantsBulkUpdate: ${JSON.stringify(ues)}`);
  }
  return data?.productVariantsBulkUpdate?.productVariants || [];
}

async function inventorySetQuantitiesBatch(token, locationId, items) {
  if (!items.length) return;
  const input = {
    name: 'available',
    reason: 'correction',
    referenceDocumentUri: 'caviar-scraper://variant-sync',
    ignoreCompareQuantity: true,
    quantities: items.map((x) => ({
      inventoryItemId: x.inventoryItemId,
      locationId,
      quantity: x.quantity
    }))
  };
  const data = await graphql(
    token,
    `mutation InvSet($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message }
      }
    }`,
    { input }
  );
  const ues = data?.inventorySetQuantities?.userErrors || [];
  if (Array.isArray(ues) && ues.length) {
    throw new Error(`inventorySetQuantities: ${JSON.stringify(ues)}`);
  }
}

function variantSortKey(v) {
  const g = gramsFromShopifyVariant(v);
  if (g == null) return { missing: 1, grams: Number.MAX_SAFE_INTEGER, title: String(v?.title || '') };
  return { missing: 0, grams: g, title: String(v?.title || '') };
}

function buildVariantReorderPositions(productNorm) {
  const vars = Array.isArray(productNorm?.variants) ? productNorm.variants : [];
  if (vars.length <= 1) return [];
  const sorted = [...vars].sort((a, b) => {
    const ak = variantSortKey(a);
    const bk = variantSortKey(b);
    if (ak.missing !== bk.missing) return ak.missing - bk.missing;
    if (ak.grams !== bk.grams) return ak.grams - bk.grams;
    return ak.title.localeCompare(bk.title, 'ru');
  });
  const positions = [];
  for (let i = 0; i < sorted.length; i++) {
    const wanted = sorted[i];
    const currentIdx = vars.findIndex((v) => v?.id === wanted?.id);
    if (currentIdx !== i && wanted?.id) {
      // Shopify positions are 1-based.
      positions.push({ id: wanted.id, position: i + 1 });
    }
  }
  return positions;
}

async function productVariantsBulkReorder(token, productId, positions) {
  if (!Array.isArray(positions) || positions.length === 0) return 0;
  const data = await graphql(
    token,
    `mutation Reorder($productId: ID!, $positions: [ProductVariantPositionInput!]!) {
      productVariantsBulkReorder(productId: $productId, positions: $positions) {
        userErrors { field message }
      }
    }`,
    { productId, positions }
  );
  const ues = data?.productVariantsBulkReorder?.userErrors || [];
  if (Array.isArray(ues) && ues.length) {
    throw new Error(`productVariantsBulkReorder: ${JSON.stringify(ues)}`);
  }
  return positions.length;
}

function optionValueNames(opt) {
  const vals = opt?.values;
  if (Array.isArray(vals) && vals.length)
    return new Set(vals.map((x) => String(x).trim()).filter(Boolean));
  const ovs = opt?.optionValues || [];
  if (ovs.length) return new Set(ovs.map((x) => String(x.name || '').trim()).filter(Boolean));
  return new Set();
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normPolicy(v) {
  return String(v || '')
    .trim()
    .toUpperCase();
}

function snapshotVariantByGrams(productNorm) {
  const m = new Map();
  const vars = Array.isArray(productNorm?.variants) ? productNorm.variants : [];
  for (const v of vars) {
    const g = gramsFromShopifyVariant(v);
    if (g == null) continue;
    if (!m.has(g)) {
      m.set(g, {
        grams: g,
        variant_id: v?.id || null,
        price: numOrNull(v?.price),
        qty: numOrNull(v?.inventoryQuantity),
        inventory_policy: normPolicy(v?.inventoryPolicy)
      });
    }
  }
  return m;
}

function buildVariantChanges(beforeProduct, afterProduct) {
  const before = snapshotVariantByGrams(beforeProduct);
  const after = snapshotVariantByGrams(afterProduct);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const out = [];
  for (const grams of [...keys].sort((a, b) => a - b)) {
    const b = before.get(grams) || null;
    const a = after.get(grams) || null;
    if (!b && a) {
      out.push({
        grams,
        change_type: 'added',
        variant_id_before: null,
        variant_id_after: a.variant_id,
        price_from: null,
        price_to: a.price,
        qty_from: null,
        qty_to: a.qty,
        inventory_policy_from: null,
        inventory_policy_to: a.inventory_policy
      });
      continue;
    }
    if (b && !a) {
      out.push({
        grams,
        change_type: 'removed',
        variant_id_before: b.variant_id,
        variant_id_after: null,
        price_from: b.price,
        price_to: null,
        qty_from: b.qty,
        qty_to: null,
        inventory_policy_from: b.inventory_policy,
        inventory_policy_to: null
      });
      continue;
    }
    if (!b || !a) continue;
    const changed =
      b.price !== a.price || b.qty !== a.qty || b.inventory_policy !== a.inventory_policy || b.variant_id !== a.variant_id;
    if (!changed) continue;
    out.push({
      grams,
      change_type: 'updated',
      variant_id_before: b.variant_id,
      variant_id_after: a.variant_id,
      price_from: b.price,
      price_to: a.price,
      qty_from: b.qty,
      qty_to: a.qty,
      inventory_policy_from: b.inventory_policy,
      inventory_policy_to: a.inventory_policy
    });
  }
  return out;
}

/**
 * Aligns Shopify product variants with supplier JSON: prices, inventory policy, qty,
 * creates missing weights (option values + variants), zeros orphans (not on supplier).
 */
async function executeVariantSyncFromSupplier(productGid, supplierProduct, locationNameOrId, opts = {}) {
  const dryRun = opts.dryRun === true;
  const token = await getAccessToken();
  let locationId = locationNameOrId;
  if (!String(locationNameOrId || '').startsWith('gid://')) {
    locationId = await getLocationIdByName(token, locationNameOrId);
  }

  let productNorm = await fetchProductForSync(token, productGid);
  if (!productNorm) throw new Error(`Product not found: ${productGid}`);
  const beforeSyncProduct = productNorm;

  let weightOpt = getWeightOption(productNorm);
  if (!weightOpt?.id) throw new Error('Could not detect a product option for variant weights.');

  let plan = buildVariantSyncPlan(supplierProduct, productNorm);
  if (dryRun) return { ok: true, dryRun: true, plan, productId: productGid };

  const existingNames = optionValueNames(weightOpt);
  const namesToAdd = [];
  for (const c of plan.toCreate) {
    if (!existingNames.has(c.optionLabel)) namesToAdd.push(c.optionLabel);
  }
  if (namesToAdd.length) {
    productNorm = await productOptionUpdateAddValues(token, productNorm.id, weightOpt.id, namesToAdd);
    plan = buildVariantSyncPlan(supplierProduct, productNorm);
    weightOpt = getWeightOption(productNorm) || weightOpt;
  }

  if (plan.toCreate.length) {
    const creates = plan.toCreate.map((c) => {
      const row = {
        optionValues: [{ optionId: weightOpt.id, name: c.optionLabel }],
        inventoryPolicy: c.inventoryPolicy
      };
      if (c.price != null) row.price = c.price;
      return row;
    });
    await productVariantsBulkCreateRun(token, productNorm.id, creates);
    productNorm = await fetchProductForSync(token, productGid);
    plan = buildVariantSyncPlan(supplierProduct, productNorm);
  }

  const shopifyByGrams = variantMapByGrams(productNorm.variants || []);

  const bulkInputs = [];
  const invItems = [];

  for (const z of plan.toZeroOut) {
    const v = shopifyByGrams.get(z.grams);
    const vid = v?.id || z.variantId;
    let iid = v?.inventoryItem?.id || z.inventoryItemId;
    if (!iid) iid = await getInventoryItemIdForVariant(token, vid);
    bulkInputs.push({ id: vid, inventoryPolicy: 'DENY' });
    invItems.push({ inventoryItemId: iid, quantity: 0 });
  }

  for (const u of plan.toUpdate) {
    let iid = u.inventoryItemId;
    const v = shopifyByGrams.get(u.grams);
    const vid = v?.id || u.variantId;
    if (!iid && v?.inventoryItem?.id) iid = v.inventoryItem.id;
    if (!iid) iid = await getInventoryItemIdForVariant(token, vid);
    const row = { id: vid, inventoryPolicy: u.inventoryPolicy };
    if (u.price != null) row.price = u.price;
    bulkInputs.push(row);
    invItems.push({ inventoryItemId: iid, quantity: u.quantity });
  }

  const chunk = 50;
  for (let i = 0; i < bulkInputs.length; i += chunk) {
    await productVariantsBulkUpdateChunk(token, productNorm.id, bulkInputs.slice(i, i + chunk));
  }

  const invChunk = 50;
  for (let i = 0; i < invItems.length; i += invChunk) {
    await inventorySetQuantitiesBatch(token, locationId, invItems.slice(i, i + invChunk));
  }

  // Keep Shopify variant order predictable in Admin/UI: smallest weight -> largest.
  productNorm = await fetchProductForSync(token, productGid);
  const reorderPositions = buildVariantReorderPositions(productNorm);
  let reorderMoved = 0;
  try {
    reorderMoved = await productVariantsBulkReorder(token, productNorm.id, reorderPositions);
  } catch (e) {
    // Reordering is best-effort; do not fail the whole sync if Shopify rejects positions.
    reorderMoved = 0;
  }

  const finalNorm = await fetchProductForSync(token, productGid);
  const forStatus = finalNorm || productNorm;
  const variantChanges = buildVariantChanges(beforeSyncProduct, forStatus);
  let setActiveAfterSync = false;
  const statusNow = String(forStatus?.status || '')
    .trim()
    .toUpperCase();
  if (statusNow === 'DRAFT' && productHasSellableVariant(forStatus)) {
    await setProductStatus(productNorm.id, 'ACTIVE');
    setActiveAfterSync = true;
  }

  return {
    ok: true,
    dryRun: false,
    productId: productNorm.id,
    plan: buildVariantSyncPlan(supplierProduct, forStatus),
    applied: {
      bulk_update_rows: bulkInputs.length,
      inventory_rows: invItems.length,
      option_values_added: namesToAdd.length,
      reorder_moved_rows: reorderMoved
    },
    variant_changes: variantChanges,
    set_active_after_sync: setActiveAfterSync
  };
}

module.exports = {
  buildVariantSyncPlan,
  fetchProductForSync,
  executeVariantSyncFromSupplier,
  gramsFromSupplierVariant,
  gramsFromShopifyVariant,
  weightLabelRu,
  supplierUnitPrice,
  supplierPolicyAndQty
};
