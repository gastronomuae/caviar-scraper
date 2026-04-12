import { Product, SyncedField } from "@/types";

export interface TranslateInput {
  ru_title: string;
  ru_body: string;
  ru_meta_title: string;
  ru_meta_description: string;
  /** Synced fields (image alts, etc.) to translate in the same request */
  syncedFields?: Array<{ key: string; value: string }>;
}

export interface TranslateOutput {
  en_title: string;
  en_body: string;
  en_meta_title: string;
  en_meta_description: string;
  /** Translated synced fields — keys match the input keys */
  translatedSyncedFields?: Array<{ key: string; translatedValue: string }>;
}

export async function translateProduct(input: TranslateInput): Promise<TranslateOutput> {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error ?? `HTTP ${response.status}`);
  }

  return response.json();
}

export function getTranslateInput(product: Product): TranslateInput {
  // Include non-empty synced field source values for translation
  const syncedFields: Array<{ key: string; value: string }> = (
    product.syncedFields ?? []
  )
    .filter((f: SyncedField) => f.sourceValue)
    .map((f: SyncedField) => ({ key: f.key, value: f.sourceValue }));

  return {
    ru_title: product.ru_title,
    ru_body: product.ru_body,
    ru_meta_title: product.ru_meta_title,
    ru_meta_description: product.ru_meta_description,
    ...(syncedFields.length ? { syncedFields } : {}),
  };
}
