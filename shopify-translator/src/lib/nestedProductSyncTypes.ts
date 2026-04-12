import type { ShopifySyncResourceType } from "@/types";

/**
 * PRODUCT_OPTION and PRODUCT_OPTION_VALUE are fetched directly via
 * translatableResources(resourceType: PRODUCT_OPTION/VALUE) — the same generic
 * pipeline used by all other resource types. They no longer require PRODUCT
 * to be co-selected. This function is kept as a no-op for call-site compatibility.
 */
export function normalizeNestedProductSyncTypes(types: ShopifySyncResourceType[]): ShopifySyncResourceType[] {
  return types;
}
