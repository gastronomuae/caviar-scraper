import { TranslationRecord } from "@/types";

/**
 * Push is only allowed when the record is not 100% untranslated.
 * `deriveRecordStatus` uses "new" when no translatable field is done.
 *
 * ---
 * **Syncing content from Shopify (high level):**
 *
 * - **Manual CSV**: Admin → Content → Translate & Adapt → Export → upload here. Replaces stored records; session “Pushed” flags are cleared when you upload a new file.
 * - There is **no** documented HTTP API that returns the *same* file as the Translate & Adapt **Export** button.
 * - **Automated sync** uses the **Admin GraphQL API** with `read_translations`: for each resource GID, query `translatableResource` → default locale source (`translatableContent`) + target locale translations, paginate across products/collections/etc., then rebuild `TranslationRecord[]` like `parseTranslationCSV` does.
 * - After any successful pull from Shopify, clear session push state: `setSessionPushedIds(new Set())` so “Pushed” badges reset (content may have changed in Admin).
 */
export function canPushTranslationRecord(record: TranslationRecord): boolean {
  return record.status !== "new";
}
