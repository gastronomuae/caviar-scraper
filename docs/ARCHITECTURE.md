# Architecture & operating guide

**Audience:** product/engineering review, security/architecture review, and **automation agents** (e.g. Claude, GPT) that need to modify or replicate this system.

**Scope:** This document describes the **caviar-scraper** codebase as built for **1-caviar.ae** (supplier) and **Gastronom** (Shopify export / target catalog). Names like “Gastronom” and file `from_gastronom.json` are **branding/paths**; the payload shape is Shopify-oriented (handles, GIDs, variants).

---

## 1. Business problem

1. **Source of truth A:** Live supplier catalog from **Shopify Storefront JSON** on `1-caviar.ae`, optionally restricted to specific **collections** (e.g. caviar + seafood).
2. **Source of truth B:** **Gastronom** product export (JSON array), produced elsewhere (e.g. automation) and saved as `Output/from_gastronom.json` or appended via **HTTP webhook**.
3. **Gap:** Handles and titles differ (EN supplier vs RU/other target fields). Operators need **suggested matches**, **confirmation**, and **reports** without blindly overwriting production systems.

This repo **does not** call Shopify Admin GraphQL for writes in the review flow; it persists local JSON mapping files for downstream processes.

---

## 2. High-level architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Supplier (1-caviar.ae)                       │
│  Shopify: /collections/{handle}/products.json paginated         │
└────────────────────────────┬────────────────────────────────────┘
                             │ axios
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  fetch-products-all-1caviar.js  →  Output/products_all.json     │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────┐
│  Output/from_gastronom.json  ← webhook OR manual save         │
│  (Gastronom / Shopify-shaped product array)                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  product-match.js                                               │
│  • Normalize supplier + Gastronom rows                           │
│  • Filter supplier scope (caviar/seafood — strict vs broad)     │
│  • Scoring (token Jaccard + bigram on name/description)         │
│  • buildMatchingReport, CSV, finalReport                         │
│  • getUnpairedGastronomProducts / getUnpairedSupplierProducts  │
└──────────────┬──────────────────────────────┬───────────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────┐   ┌────────────────────────────────┐
│  review-server.js :3001  │   │  CLI: match:csv, match:summary,  │
│  + public/review.html    │   │  mapping:prune, normalize:*     │
│  Confirm → product_      │   └────────────────────────────────┘
│  mapping.json            │
└──────────────────────────┘
```

**Secondary HTTP service:** `server.js` on port **3000** appends POST bodies to `Output/from_gastronom.json` (merge with existing array). Use for integration platforms; validate auth at a reverse proxy in production.

---

## 3. Key files and responsibilities

| Path | Role |
|------|------|
| `index.js` | Entry: runs supplier fetch `main()`. |
| `src/fetch-products-all-1caviar.js` | Fetches collections listed in `COLLECTION_HANDLES`, dedupes by Shopify product `id`, maps to `products_all` shape, writes `Output/products_all.json`. |
| `src/product-match.js` | **Single core library:** paths (`PATHS`), load/save mapping & state, filter, normalize, scoring, report rows, unpaired helpers, CSV writer. |
| `src/review-server.js` | Express app: `/api/report`, `/api/unpaired-gastronom`, … (see §6), serves `public/review.html`. Handles **EADDRINUSE** with a clear message. |
| `public/review.html` | Client UI: navigate supplier scope, suggestions, confirm/no-match/manual search, modals for unpaired Gastronom/supplier. Uses `API` base when not served from `:3001`. |
| `src/server.js` | Webhook: `POST /gastronom` (and legacy `/shopify`) → merge into `Output/from_gastronom.json`. |
| `src/normalize-from-gastronom.js` | Reads `from_gastronom.json`, writes `from_gastronom.normalized.json` (flattened numeric fields). |
| `src/matching-summary-report.js` | Prints and writes `Output/matching_summary_report.txt`. |
| `src/prune-product-mapping.js` | Drops `product_mapping.json` keys whose handles no longer exist in `products_all.json`. |
| `src/url-utils.js` | Helpers to rewrite supplier URLs toward `gastronom.ae` (documentation / tooling; not central to matcher). |
| `data/field-mapping.json` | Human-oriented field mapping notes (not loaded by core matcher by default). |

**Legacy / auxiliary:** `src/matcher.js` implements a different id-based comparison; not wired into `review-server` or `product-match`.

---

## 4. Data contracts

### 4.1 `Output/products_all.json`

Array of supplier products. Minimal fields used by matching:

- `name`, `description`, `image`, `url` (canonical `https://1-caviar.ae/products/{handle}`)
- `promotional_price` (string with `AED`), `variants[]` with `weight`, etc.

**Handle extraction:** regex on `url` — `/products/([^/?#]+)`.

### 4.2 `Output/from_gastronom.json`

Array of Gastronom (Shopify-shaped) products, e.g.:

- `name`, `handle`, `description`, `vendor`, `product_type`
- `variants[]` with `price`, `weight`, `shopify_variant_id`, etc.
- `Image url` (space in key) — normalized in code
- `Product Status` — e.g. `ACTIVE` / `DRAFT`
- `shopify_product_id` — e.g. `gid://shopify/Product/123`

**Fallback file:** `Output/shopify_from_gastronom.json` if primary missing/empty (see `loadShopifyNormalized()`).

### 4.3 `Output/product_mapping.json`

Object: **`supplier_handle` → `shopify_product_id` (GID string)**.  
Updated by **Confirm** in the UI (`POST /api/confirm`). This is the **confirmed** alignment layer on top of heuristics.

### 4.4 `Output/match_review_state.json`

- `noMatchHandles`: string[] — supplier handles explicitly marked **no match**
- `manualNotes`: reserved object

### 4.5 Generated reports

- `Output/matching_report.csv` — per-row suggestions and status
- `Output/matching_summary_report.txt` — aggregate stats from `matching-summary-report.js`

---

## 5. Matching logic (concise)

1. **Supplier filter:** `filterSupplierCaviarSeafood()` — by default **broad** (env `PRODUCT_MATCH_BROAD=1`, set by `review-server` if unset). Strict mode: regex `caviar|seafood` only on pathname + name/description (not full URL host).
2. **Suggestions:** Combined name + description score vs Gastronom list; top N suggestions per row.
3. **Row status (review):**
   - Confirmed if `product_mapping[handle]` set
   - No match if handle in `match_review_state.noMatchHandles`
   - Else **auto by handle** if Gastronom has same `handle`
   - Else **needs review** with scored suggestions

**Unpaired Gastronom:** Gastronom rows with no supplier handle match **and** no mapping from a supplier handle still in `products_all.json` pointing to that GID — see `getUnpairedGastronomProducts()`.

**Unpaired supplier:** Supplier rows with no shared handle and no mapping GID present in Gastronom export — see `getUnpairedSupplierProducts()`.

---

## 6. HTTP API (review server, default port 3001)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serves `review.html` |
| GET | `/api/report` | Full matching report `{ rows, shopify, supplierCount }` |
| GET | `/api/unpaired-gastronom` | Gastronom products not linked to current supplier file |
| GET | `/api/unpaired-supplier` | Supplier products not linked to Gastronom export |
| GET | `/api/search?q=` | Search Gastronom list |
| GET | `/api/report.csv` | Download CSV |
| GET | `/api/final-report` | JSON summary (confirmed / new / unmatched) |
| POST | `/api/confirm` | Body: `source_handle`, `shopify_product_id` |
| POST | `/api/no-match` | Body: `source_handle` |

Env: `REVIEW_PORT` (default `3001`), `PRODUCT_MATCH_BROAD` (`0` strict, `1` broad).

---

## 7. Environment & Windows notes

- Paths use **`Output/`** (capital O) for core data; legacy duplicate **`output/`** may exist on case-insensitive filesystems — prefer **`Output/`** in code and webhooks.
- **Port conflicts:** If `npm run review` exits with code `1`, check `EADDRINUSE` message; stop the old PID or set `REVIEW_PORT=3002`.
- **Browser:** Open the app from **`http://localhost:3001`**, not `file://`, so `/api/report` resolves.

---

## 8. Scaling to another site (checklist)

To replicate for **supplier X** + **target catalog Y**:

1. **Fetcher:** Copy `fetch-products-all-1caviar.js` → e.g. `fetch-products-all-{vendor}.js`; set `BASE`, `COLLECTION_HANDLES` (or switch back to full `/products.json` if needed), output path (e.g. `Output/products_supplier_x.json`).
2. **Paths:** Extend or parameterize `PATHS` in `product-match.js` (or read from env: `SUPPLIER_JSON`, `GASTRONOM_JSON`).
3. **Normalization:** Gastronom file must keep the **same logical fields** expected by `normalizeShopifyList()` or extend that function for new columns.
4. **Filter:** Adjust `filterSupplierCaviarSeafood` or replace with site-specific taxonomy / collection rules.
5. **Language:** Matching uses RU/EN mix in `name_ru` / `name_en` — tune tokenization or add transliteration if needed.
6. **Review UI:** Update copy in `review.html` (brand names, help text). `API` base logic already supports localhost on another port pointing at 3001.
7. **Webhook:** Point automation at `server.js` path and ensure disk path matches `PATHS.shopifyPrimary`.

---

## 9. Security & production considerations

- **Webhook:** `server.js` has **no authentication**; do not expose raw to the internet without API key / IP allowlist / reverse proxy.
- **Outputs:** JSON files may contain pricing, SKUs, business copy; treat `Output/` as sensitive for git and backups.
- **Dependencies:** `express`, `axios` — keep patched (`npm audit`).

---

## 10. Machine-readable summary (for LLMs)

```yaml
project: caviar-scraper
runtime: Node.js (CommonJS)
primary_language: JavaScript
supplier_site: https://1-caviar.ae
supplier_fetch_method: Shopify collection JSON API
supplier_output: Output/products_all.json
target_catalog_file: Output/from_gastronom.json
target_catalog_fallback: Output/shopify_from_gastronom.json
confirmed_mapping_file: Output/product_mapping.json
review_state_file: Output/match_review_state.json
core_logic_module: src/product-match.js
review_ui_port: 3001
webhook_ingest_port: 3000
webhook_paths: [/gastronom, /shopify]
collection_handles_editable_in: src/fetch-products-all-1caviar.js (COLLECTION_HANDLES)
broad_seafood_filter_env: PRODUCT_MATCH_BROAD
strict_filter: PRODUCT_MATCH_BROAD=0
entrypoints:
  fetch: index.js / npm run fetch:products-all
  review: npm run review
  webhook: node src/server.js
key_extension_points:
  - COLLECTION_HANDLES and BASE in fetch script
  - PATHS and filterSupplierCaviarSeafood in product-match.js
  - normalizeShopifyList field mapping
  - review.html labels and API base
non_goals_in_repo:
  - No Shopify Admin write API in review flow
  - No hosted database; JSON files are the persistence layer
```

---

## 11. Changelog narrative (historical context)

Evolution relevant to operators and reviewers:

- Supplier fetch moved from full-store pagination to **configurable collections** (`caviar`, `seafood`) with **dedupe by product id**.
- **Make.com** naming was unified to **Gastronom**; files renamed (`from_make.json` → `from_gastronom.json`, etc.); API route `unpaired-make` → `unpaired-gastronom`.
- **Review UI** gained unpaired overlays (Gastronom-only / supplier-only), sorted by product status, numeric GID display, image links for supplier products, resilient `load()` and port error handling.
- **Prune** script and **summary** script support housekeeping after catalog changes.

*(Exact dates/commits belong in git history once the repo is on GitHub.)*

---

## 12. Contact / ownership

Fill in repo owner, Slack channel, and on-call for **webhook URL** rotation and **Gastronom** export ownership when publishing internally or on GitHub.
