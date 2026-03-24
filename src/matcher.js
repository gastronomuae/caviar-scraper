function compareProducts(supplierProducts, shopifyProducts, mapping) {
    const mapped = [];
    const newProducts = [];
    const missing = [];
  
    const mappedSupplierIds = mapping.map(m => m.supplier_id);
  
    // Check supplier side
    supplierProducts.forEach(p => {
      const isMapped = mappedSupplierIds.includes(p.id);
  
      if (isMapped) {
        mapped.push(p);
      } else {
        newProducts.push(p);
      }
    });
  
    // Check missing (mapped but no longer in supplier)
    mapping.forEach(m => {
      const exists = supplierProducts.find(p => p.id === m.supplier_id);
  
      if (!exists) {
        missing.push(m);
      }
    });
  
    return {
      mapped,
      newProducts,
      missing
    };
  }
  
  module.exports = compareProducts;