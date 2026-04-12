/**
 * Shopify Admin API version for GraphQL (`/admin/api/{version}/graphql.json`)
 * and REST calls in this app.
 *
 * **GraphQL `menus` query:** The `QueryRoot.menus` field is only available on
 * Admin GraphQL **2024-07 and newer** (navigation menu APIs). Older versions
 * (e.g. 2023-10) do not define `menus` on the schema.
 *
 * **MEDIA_IMAGE / image alt text:** `translatableResources(resourceType: MEDIA_IMAGE)`
 * and `translatableResource(resourceId: "gid://shopify/MediaImage/...")` are only
 * active from **2025-10** onward (Shopify changelog June 29 2025). The enum value
 * exists in 2025-07 but all calls return invalid-id / empty — bumped to 2025-10.
 *
 * This project pins **2025-10** — all existing queries remain compatible.
 * Import this constant anywhere you build Admin API URLs so sync, push, and
 * probes stay aligned.
 */
export const SHOPIFY_ADMIN_API_VERSION = "2025-10" as const;
