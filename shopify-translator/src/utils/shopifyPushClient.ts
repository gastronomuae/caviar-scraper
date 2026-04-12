import { TranslationRecord, type AppSettings } from "@/types";
import { loadSettings } from "@/lib/settingsStorage";
import { isEffectivelyEmpty } from "@/utils/isEffectivelyEmpty";

/** Requires store domain in Settings; Admin token is resolved on the server. */
export function requireShopifyDomainForApi(): AppSettings {
  const settings = loadSettings();
  if (!settings.shopifyDomain?.trim()) {
    throw new Error("Connect to Shopify in Settings (store domain) first.");
  }
  return settings;
}

/** Push one record’s English fields to Shopify. Returns number of fields registered. */
export async function pushRecordToShopify(record: TranslationRecord): Promise<number> {
  const settings = requireShopifyDomainForApi();
  console.log("[push/all-fields]", record.fields.map((f) => `${f.field}=${f.en_content ? "✓" : "empty"}`).join(", "));
  const fieldsToSend = record.fields
    .filter((f) => f.en_content && !isEffectivelyEmpty(f.en_content))
    .map((f) => ({ key: f.field, value: f.en_content }));

  if (fieldsToSend.length === 0) {
    throw new Error(`Nothing to push for “${record.handle}” — translate first.`);
  }

  const res = await fetch("/api/shopify/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shopifyDomain: settings.shopifyDomain,
      shopifyClientId: settings.shopifyClientId,
      shopifyClientSecret: settings.shopifyClientSecret,
      resourceId: record.identification,
      resourceType: record.type,
      locale: record.locale,
      fields: fieldsToSend,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; pushed?: number };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.pushed as number;
}
