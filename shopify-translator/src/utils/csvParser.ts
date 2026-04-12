import Papa from "papaparse";
import { Product, RawCSVRow } from "@/types";

export function parseShopifyCSV(
  file: File
): Promise<{ products: Product[]; rawRows: RawCSVRow[]; headers: string[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse<RawCSVRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete(results) {
        const headers = results.meta.fields ?? [];
        const rawRows = results.data;

        // Group rows by handle — Shopify exports multi-image products as multiple rows.
        // Only the first row per handle carries Title / Body / SEO fields.
        // Image alt texts are now sourced from Shopify's Translations API (sync engine),
        // not from the CSV "Image Alt Text" column.
        const seen = new Map<string, Product>();

        rawRows.forEach((row, index) => {
          const handle = (row["Handle"] ?? "").trim();
          if (!handle) return;

          if (!seen.has(handle)) {
            seen.set(handle, {
              id: `product-${index}-${handle}`,
              handle,
              ru_title: (row["Title"] ?? "").trim(),
              ru_body: (row["Body (HTML)"] ?? "").trim(),
              ru_meta_title: (row["SEO Title"] ?? "").trim(),
              ru_meta_description: (row["SEO Description"] ?? "").trim(),
              en_title: "",
              en_body: "",
              en_meta_title: "",
              en_meta_description: "",
              status: "new",
            });
          }
        });

        resolve({
          products: Array.from(seen.values()),
          rawRows,
          headers,
        });
      },
      error(err) {
        reject(err);
      },
    });
  });
}
