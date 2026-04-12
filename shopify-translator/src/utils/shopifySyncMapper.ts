import { TranslationRecord, TranslationField, ShopifySyncProductRow } from "@/types";
import { TARGET_LOCALE } from "@/lib/storeConfig";
import { deriveRecordStatus, getFieldType } from "@/utils/csvParser";
import { deriveTranslationStatus } from "@/utils/translationStatus";

function fieldStatus(en: string): TranslationField["status"] {
  return en.trim() ? "done" : "missing";
}

const PREFERRED_FIELD_ORDER = ["title", "body_html", "meta_title", "meta_description", "product_type"];

function fieldsFromDynamicRow(row: ShopifySyncProductRow): TranslationField[] {
  const dyn = row.fields ?? {};
  const entries = Object.entries(dyn);
  if (entries.length === 0) return [];

  const orderIndex = new Map(PREFERRED_FIELD_ORDER.map((k, i) => [k, i]));
  entries.sort(([a], [b]) => {
    const ai = orderIndex.get(a);
    const bi = orderIndex.get(b);
    if (ai != null && bi != null) return ai - bi;
    if (ai != null) return -1;
    if (bi != null) return 1;
    return a.localeCompare(b);
  });

  const imageAltRe = /^image\.(\d+)\.alt$/;
  return entries.map(([fieldKey, value]) => {
    const en = value?.en_content ?? "";
    const imageAltMatch = imageAltRe.exec(fieldKey);
    return {
      field: fieldKey,
      fieldType: value?.fieldType ?? getFieldType(fieldKey),
      ru_content: value?.ru_content ?? "",
      en_content: en,
      csvStatus: "",
      status: fieldStatus(en),
      displayName: value?.displayName ?? (imageAltMatch ? `Image alt — #${imageAltMatch[1]}` : undefined),
      namespaceKey: value?.namespaceKey,
      metafieldId: value?.metafieldId,
      parentTitle: value?.parentTitle,
      parentType: value?.parentType,
    };
  });
}

/**
 * After a new Shopify sync, if `ru_title` changed vs the last stored snapshot,
 * mark the English title field as outdated (when EN was non-empty).
 */
export function mergeShopifySyncWithPrevious(
  incoming: TranslationRecord[],
  previous: TranslationRecord[]
): TranslationRecord[] {
  const prevById = new Map(previous.map((r) => [r.id, r]));
  return incoming.map((rec) => {
    const prev = prevById.get(rec.id);
    const titleF = rec.fields.find((f) => f.field === "title");
    const newRu = titleF?.ru_content ?? "";

    if (!prev) {
      return {
        ...rec,
        sourceTitleAtSync: newRu,
        translation_status: deriveTranslationStatus(rec.fields),
      };
    }

    const prevSnap =
      prev.sourceTitleAtSync ??
      prev.fields.find((f) => f.field === "title")?.ru_content ??
      "";

    if (newRu === prevSnap) {
      return {
        ...rec,
        sourceTitleAtSync: newRu,
        translation_status: deriveTranslationStatus(rec.fields),
      };
    }

    const fields = rec.fields.map((f) => {
      if (f.field !== "title") return f;
      const enOk = f.en_content.trim().length > 0;
      return {
        ...f,
        status: enOk ? ("outdated" as const) : f.status,
      };
    });

    return {
      ...rec,
      fields,
      status: deriveRecordStatus(fields),
      sourceTitleAtSync: prevSnap,
    };
  });
}

/**
 * Maps POST /api/shopify/sync JSON to in-app translation records.
 *
 * @param rows          Raw rows from the sync API.
 * @param targetLocale  The working target locale (e.g. "en", "de"). Falls back to the
 *                      compile-time TARGET_LOCALE constant when omitted. Pass the value
 *                      returned by readActiveLocale() so that records carry the correct
 *                      locale for both display and push.
 */
export function shopifySyncRowsToTranslationRecords(
  rows: ShopifySyncProductRow[],
  targetLocale?: string,
): TranslationRecord[] {
  return rows.map((row) => {
    const kind = row.resourceKind ?? "PRODUCT";
    const identification = String(row.shopify_id ?? "").trim();
    const locale = targetLocale?.trim() || TARGET_LOCALE;
    const id = `${kind}__${identification}__${locale}`;

    const dynamicFields = fieldsFromDynamicRow(row);

    // For theme and shop-policy records, inject a synthetic display-title field so
    // ProductRow can show the human-readable name (e.g. "Refund Policy").
    // This field is filtered out by ThemeEditor and never pushed to Shopify.
    if ((kind === "ONLINE_STORE_THEME" || kind === "SHOP_POLICY") && row.ru_title) {
      const alreadyHasTitle = dynamicFields.some((f) => f.field === "__display_title__");
      if (kind === "SHOP_POLICY") {
        console.info(
          `[mapper/SHOP_POLICY] id=${identification} ru_title="${row.ru_title}" ` +
          `alreadyHasTitle=${alreadyHasTitle} dynamicFieldKeys=[${dynamicFields.map((f) => f.field).join(",")}]`,
        );
      }
      if (!alreadyHasTitle) {
        dynamicFields.unshift({
          field: "__display_title__",
          fieldType: "plain",
          ru_content: row.ru_title,
          en_content: "",
          csvStatus: "",
          status: "missing",
        });
      }
    }

    const fields: TranslationField[] = dynamicFields.length > 0 ? dynamicFields : [
      {
        field: "title",
        fieldType: getFieldType("title"),
        ru_content: row.ru_title ?? "",
        en_content: row.en_title ?? "",
        csvStatus: "",
        status: fieldStatus(row.en_title ?? ""),
      },
      {
        field: "body_html",
        fieldType: getFieldType("body_html"),
        ru_content: row.ru_body ?? "",
        en_content: row.en_body ?? "",
        csvStatus: "",
        status: fieldStatus(row.en_body ?? ""),
      },
      {
        field: "meta_title",
        fieldType: getFieldType("meta_title"),
        ru_content: row.ru_meta_title ?? "",
        en_content: row.en_meta_title ?? "",
        csvStatus: "",
        status: fieldStatus(row.en_meta_title ?? ""),
      },
      {
        field: "meta_description",
        fieldType: getFieldType("meta_description"),
        ru_content: row.ru_meta_description ?? "",
        en_content: row.en_meta_description ?? "",
        csvStatus: "",
        status: fieldStatus(row.en_meta_description ?? ""),
      },
      // product_type only applies to products
      ...(kind === "PRODUCT" ? [{
        field: "product_type",
        fieldType: getFieldType("product_type"),
        ru_content: row.ru_product_type ?? "",
        en_content: row.en_product_type ?? "",
        csvStatus: "",
        status: fieldStatus(row.en_product_type ?? ""),
      } as TranslationField] : []),
    ];

    return {
      id,
      type: kind,
      identification,
      handle: row.handle,
      locale,
      fields,
      status: deriveRecordStatus(fields),
      translation_status: deriveTranslationStatus(fields),
      used_fallback: row.used_fallback,
      resolved_source_locale: row.resolved_source_locale,
      ...(row.resourceStatus != null ? { shopifyResourceStatus: row.resourceStatus } : {}),
      ...(row.publishedAt !== undefined ? { shopifyPublishedAt: row.publishedAt } : {}),
      ...(row.metaobjectRefs?.length ? { metaobjectRefs: row.metaobjectRefs } : {}),
      // Menu parent linkage (populated for LINK records after a full sync)
      ...(row.parentMenuId !== undefined ? { parentMenuId: row.parentMenuId } : {}),
      ...(row.menuItemDepth !== undefined ? { menuItemDepth: row.menuItemDepth } : {}),
      ...(row.parentLinkId !== undefined ? { parentLinkId: row.parentLinkId } : {}),
      ...(row.itemIndex !== undefined ? { itemIndex: row.itemIndex } : {}),
    };
  });
}
