import Papa from "papaparse";
import { Product, RawCSVRow } from "@/types";

export function exportTranslatedCSV(
  products: Product[],
  rawRows: RawCSVRow[],
  originalFilename: string
): void {
  const translationMap = new Map<string, Product>();
  products.forEach((p) => translationMap.set(p.handle, p));

  // Image alt texts are managed via Shopify's Translations API (translationsRegister),
  // not written back into the CSV export.
  const translatedRows = rawRows.map((row): RawCSVRow => {
    const handle = (row["Handle"] ?? "").trim();
    const product = translationMap.get(handle);

    if (!product || product.status !== "translated") return row;

    const updated = { ...row };

    if (product.en_title && row["Title"] !== undefined) {
      updated["Title"] = product.en_title;
    }
    if (product.en_body && "Body (HTML)" in row) {
      updated["Body (HTML)"] = product.en_body;
    }
    if (product.en_meta_title && "SEO Title" in row) {
      updated["SEO Title"] = product.en_meta_title;
    }
    if (product.en_meta_description && "SEO Description" in row) {
      updated["SEO Description"] = product.en_meta_description;
    }

    return updated;
  });

  const csv = Papa.unparse(translatedRows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const baseName = originalFilename.replace(/\.csv$/i, "");
  const filename = `${baseName}_EN.csv`;

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}
