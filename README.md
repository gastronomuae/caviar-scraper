# Caviar scraper — supplier ↔ Gastronom catalog alignment

Node.js tooling to **fetch** product data from the supplier storefront (**1-caviar.ae**), **ingest** the Gastronom (Shopify) export, **match** products across languages/handles, and **review** mappings in a local web UI.

Designed for **operations and integration**: CSV/report outputs, explicit JSON “database,” and hooks to scale the same pattern to **other supplier + target store** pairs.

---

## Quick start

```bash
npm install
```

| Goal | Command |
|------|---------|
| Fetch supplier JSON (collections defined in code) | `npm start` or `npm run fetch:products-all` |
| Run match review UI | `npm run review` → open **http://localhost:3001** |
| Write matching CSV | `npm run match:csv` |
| Text summary report | `npm run match:summary` |
| Normalize Gastronom JSON | `npm run normalize:gastronom` |
| Prune stale `product_mapping.json` keys | `npm run mapping:prune` |

---

## Direct Shopify sync (no Make.com)

To fetch Gastronom products directly from Shopify Admin API (vendor filter) and write `Output/from_gastronom.json`:

```bash
npm run sync:gastronom
```

Required env vars (set in your shell):

- `SHOP` (e.g. `gastronom-ae` or `gastronom-ae.myshopify.com`)
- `CLIENT_ID`
- `CLIENT_SECRET`

Optional:

- `API_VERSION` (default `2024-01`)
- `VENDOR` (default `Caviar N1`)

The sync also writes:
- `Output/shopify_sync_delta.json` (added/removed/updated summary vs previous file)
- `Output/from_gastronom.json.bak` (backup before overwrite)

---

## Documentation for reviews & AI agents

| Document | Purpose |
|----------|---------|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | System design, data contracts, extension guide (other sites, other LLMs) |
| This README | Orientation and commands |

For **Claude / other LLMs**: start with `docs/ARCHITECTURE.md` § “Machine-readable summary” and § “Scaling to another site.”

**Documentation rhythm:** After meaningful changes (or end of day), ask in Cursor to **refresh documentation** so `README.md` and `docs/ARCHITECTURE.md` stay accurate for reviews and automation.

---

## Repository layout (high level)

```
src/
  fetch-products-all-1caviar.js   # Supplier fetch → Output/products_all.json
  product-match.js                 # Core matching, paths, CSV, reports
  review-server.js                 # Review UI API + static server (port 3001)
  sync-shopify-gastronom.js        # Shopify Admin API → Output/from_gastronom.json
  normalize-from-gastronom.js      # Flatten Gastronom export
  matching-summary-report.js       # Console + matching_summary_report.txt
  prune-product-mapping.js         # Remove orphan mapping keys
  url-utils.js                     # URL rewrite helpers (gastronom.ae)
public/
  review.html                      # Single-page review app
Output/                            # Generated & hand-curated outputs (see ARCHITECTURE)
data/                              # Reference mapping / samples (non-authoritative for runtime)
```

---

## GitHub migration

This folder may not yet be a git repo. On your machine:

```bash
cd "c:\coursor projects\caviar-scraper"
git init
git add .
git commit -m "Initial import: caviar scraper and Gastronom alignment tooling"
```

Create an empty repository on GitHub, then:

```bash
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

Decide whether **`Output/`** should be tracked (exports may contain business data). If not, uncomment `Output/` in `.gitignore`.

---

## License

ISC (see `package.json`). Adjust as needed for your organization.
