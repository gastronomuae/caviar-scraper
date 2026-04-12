/**
 * Shopify Translations API — sync engine (Path B: per-product resource fetch).
 *
 * Responsibilities:
 *   1. Resolve a product handle → Shopify GID
 *   2. Fetch translatableContent + media URLs for that GID
 *   3. Push translated values back via translationsRegister
 */

import { SyncedField } from "@/types";
import {
  isTranslatableField,
  getFieldGroup,
  getFieldLabel,
  getImageNumericId,
} from "./shopifySyncMapper";

const API_VERSION = "2025-07";

// ── HTTP layer ───────────────────────────────────────────────────────────

function endpoint(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;
}

async function shopifyFetch<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(endpoint(shopDomain), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Shopify API HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }

  return json.data as T;
}

// ── GraphQL documents ────────────────────────────────────────────────────

const FIND_PRODUCT_BY_HANDLE = /* GraphQL */ `
  query FindProductByHandle($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        handle
      }
    }
  }
`;

/**
 * Fetches translatableContent alongside the product's MediaImage nodes so we
 * can build a numeric-ID → CDN-URL map for thumbnail display.
 */
const TRANSLATABLE_RESOURCE_WITH_MEDIA = /* GraphQL */ `
  query TranslatableResourceWithMedia($resourceId: ID!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent {
        key
        value
        digest
        locale
      }
    }
    node(id: $resourceId) {
      ... on Product {
        media(first: 50) {
          nodes {
            ... on MediaImage {
              id
              image {
                url
              }
            }
          }
        }
      }
    }
  }
`;

const TRANSLATIONS_REGISTER = /* GraphQL */ `
  mutation TranslationsRegister(
    $resourceId: ID!
    $translations: [TranslationInput!]!
  ) {
    translationsRegister(
      resourceId: $resourceId
      translations: $translations
    ) {
      userErrors {
        field
        message
      }
      translations {
        key
        value
        locale
      }
    }
  }
`;

// ── Response shape helpers ────────────────────────────────────────────────

interface GqlProductsResponse {
  products: {
    nodes: Array<{ id: string; handle: string }>;
  };
}

interface GqlTranslatableResourceResponse {
  translatableResource: {
    resourceId: string;
    translatableContent: Array<{
      key: string;
      value: string;
      digest: string;
      locale: string;
    }>;
  };
  node: {
    media?: {
      nodes: Array<{
        id: string;
        image?: { url: string };
      }>;
    };
  };
}

interface GqlTranslationsRegisterResponse {
  translationsRegister: {
    userErrors: Array<{ field: string[]; message: string }>;
    translations: Array<{ key: string; value: string; locale: string }>;
  };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Resolves a product handle to its Shopify GID.
 * Returns null when the product is not found.
 */
export async function findProductIdByHandle(
  shopDomain: string,
  accessToken: string,
  handle: string
): Promise<string | null> {
  const data = await shopifyFetch<GqlProductsResponse>(
    shopDomain,
    accessToken,
    FIND_PRODUCT_BY_HANDLE,
    { query: `handle:${handle}` }
  );
  return data.products.nodes[0]?.id ?? null;
}

/**
 * Fetches all translatable fields for a product, enriched with group/label metadata.
 * Skips fields in SKIP_FIELDS.
 *
 * Also returns a numeric MediaImage ID → CDN URL map so the editor can show
 * thumbnails next to each image alt field.
 */
export async function fetchProductSyncedFields(
  shopDomain: string,
  accessToken: string,
  resourceId: string
): Promise<{ fields: SyncedField[]; imageUrlMap: Record<string, string> }> {
  const data = await shopifyFetch<GqlTranslatableResourceResponse>(
    shopDomain,
    accessToken,
    TRANSLATABLE_RESOURCE_WITH_MEDIA,
    { resourceId }
  );

  // Build numeric MediaImage ID → CDN URL map for thumbnail display
  const imageUrlMap: Record<string, string> = {};
  for (const node of data.node?.media?.nodes ?? []) {
    if (node.image?.url) {
      const numericId = getImageNumericId(`image.${node.id}.alt`);
      if (numericId) imageUrlMap[numericId] = node.image.url;
    }
  }

  const fields: SyncedField[] = data.translatableResource.translatableContent
    .filter((item) => isTranslatableField(item.key))
    .map((item) => ({
      key: item.key,
      sourceValue: item.value ?? "",
      translatedValue: "",
      digest: item.digest,
      group: getFieldGroup(item.key),
      label: getFieldLabel(item.key),
    }));

  return { fields, imageUrlMap };
}

/**
 * Pushes translated fields to Shopify via translationsRegister.
 * Silently skips entries where translatedValue is empty.
 */
export async function pushTranslations(
  shopDomain: string,
  accessToken: string,
  resourceId: string,
  locale: string,
  fields: SyncedField[]
): Promise<{ success: boolean; errors: string[] }> {
  const translations = fields
    .filter((f) => f.translatedValue.trim())
    .map((f) => ({
      key: f.key,
      value: f.translatedValue,
      locale,
      translatableContentDigest: f.digest,
    }));

  if (!translations.length) {
    return { success: true, errors: [] };
  }

  const data = await shopifyFetch<GqlTranslationsRegisterResponse>(
    shopDomain,
    accessToken,
    TRANSLATIONS_REGISTER,
    { resourceId, translations }
  );

  const errors = data.translationsRegister.userErrors.map(
    (e) => `${e.field.join(".")}: ${e.message}`
  );

  return { success: errors.length === 0, errors };
}
