"use client";

import { useEffect, useState, useCallback } from "react";
import UploadCSV from "@/components/UploadCSV";
import ProductTable from "@/components/ProductTable";
import ProductEditor from "@/components/ProductEditor";
import { parseShopifyCSV } from "@/utils/csvParser";
import { translateProduct, getTranslateInput } from "@/utils/openai";
import { exportTranslatedCSV } from "@/utils/csvExporter";
import { Product, RawCSVRow, SyncedField } from "@/types";

const STORAGE_KEY = "shopify_translator_state_v3";

// Whether the app has Shopify API credentials wired up.
// Set NEXT_PUBLIC_SHOPIFY_ENABLED=1 in .env.local when credentials are configured.
const SHOPIFY_ENABLED =
  process.env.NEXT_PUBLIC_SHOPIFY_ENABLED === "1" ||
  process.env.NEXT_PUBLIC_SHOPIFY_ENABLED === "true";

interface PersistedState {
  products: Product[];
  rawRows: RawCSVRow[];
  filename: string;
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [rawRows, setRawRows] = useState<RawCSVRow[]>([]);
  const [filename, setFilename] = useState<string>("");
  const [isUploading, setIsUploading] = useState(false);
  const [showUntranslatedOnly, setShowUntranslatedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Hydrate from localStorage ──
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: PersistedState = JSON.parse(saved);
        setProducts(
          parsed.products.map((p) => ({
            ...p,
            isTranslating: false,
            // Defensive defaults for any fields added after initial storage
            syncedFields: p.syncedFields ?? undefined,
            imageUrlMap: p.imageUrlMap ?? undefined,
            shopifyId: p.shopifyId ?? undefined,
          }))
        );
        setRawRows(parsed.rawRows);
        setFilename(parsed.filename);
      }
    } catch {
      // ignore corrupted storage
    }
    setHydrated(true);
  }, []);

  // ── Persist on change ──
  useEffect(() => {
    if (!hydrated || products.length === 0) return;
    const state: PersistedState = { products, rawRows, filename };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // quota exceeded — silent
    }
  }, [products, rawRows, filename, hydrated]);

  // ── Upload ──
  async function handleUpload(file: File) {
    setIsUploading(true);
    setError(null);
    try {
      const { products: parsed, rawRows: rows } = await parseShopifyCSV(file);
      if (parsed.length === 0) {
        setError(
          "No products found. Make sure this is a valid Shopify product export CSV."
        );
        return;
      }
      setProducts(parsed);
      setRawRows(rows);
      setFilename(file.name);
    } catch (e) {
      setError(
        `Failed to parse CSV: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    } finally {
      setIsUploading(false);
    }
  }

  // ── Translate single product ──
  const handleTranslate = useCallback(
    async (id: string) => {
      const product = products.find((p) => p.id === id);
      if (!product) return;

      setProducts((prev) =>
        prev.map((p) => (p.id === id ? { ...p, isTranslating: true } : p))
      );
      setError(null);

      try {
        const result = await translateProduct(getTranslateInput(product));

        // Merge translatedSyncedFields back into the product's syncedFields
        const updatedSyncedFields: SyncedField[] | undefined =
          result.translatedSyncedFields?.length && product.syncedFields
            ? product.syncedFields.map((f) => {
                const match = result.translatedSyncedFields!.find(
                  (t) => t.key === f.key
                );
                return match ? { ...f, translatedValue: match.translatedValue } : f;
              })
            : product.syncedFields;

        setProducts((prev) =>
          prev.map((p) =>
            p.id === id
              ? {
                  ...p,
                  en_title: result.en_title,
                  en_body: result.en_body,
                  en_meta_title: result.en_meta_title,
                  en_meta_description: result.en_meta_description,
                  syncedFields: updatedSyncedFields,
                  status: "translated",
                  isTranslating: false,
                }
              : p
          )
        );
      } catch (e) {
        setError(
          `Translation failed: ${e instanceof Error ? e.message : "Unknown error"}`
        );
        setProducts((prev) =>
          prev.map((p) => (p.id === id ? { ...p, isTranslating: false } : p))
        );
      }
    },
    [products]
  );

  // ── Translate all (sequential) ──
  const handleTranslateAll = useCallback(async () => {
    const queue = products.filter((p) => p.status !== "translated" && !p.isTranslating);
    if (!queue.length) return;
    setError(null);
    for (const product of queue) {
      await handleTranslate(product.id);
    }
  }, [products, handleTranslate]);

  // ── Sync a product from Shopify Translations API ──
  const handleSync = useCallback(
    async (id: string) => {
      const product = products.find((p) => p.id === id);
      if (!product) return;
      setError(null);

      try {
        const res = await fetch("/api/shopify/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: product.handle,
            resourceId: product.shopifyId,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            (err as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }

        const {
          shopifyId,
          fields,
          imageUrlMap,
        }: { shopifyId: string; fields: SyncedField[]; imageUrlMap: Record<string, string> } =
          await res.json();

        setProducts((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, shopifyId, syncedFields: fields, imageUrlMap }
              : p
          )
        );
      } catch (e) {
        setError(
          `Sync failed: ${e instanceof Error ? e.message : "Unknown error"}`
        );
      }
    },
    [products]
  );

  // ── Push translations to Shopify ──
  const handlePush = useCallback(
    async (id: string) => {
      const product = products.find((p) => p.id === id);
      if (!product?.shopifyId || !product.syncedFields?.length) return;
      setError(null);

      try {
        const res = await fetch("/api/shopify/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceId: product.shopifyId,
            fields: product.syncedFields.filter((f) => f.translatedValue),
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            (err as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
      } catch (e) {
        setError(
          `Push failed: ${e instanceof Error ? e.message : "Unknown error"}`
        );
      }
    },
    [products]
  );

  // ── Save from editor ──
  function handleSave(updated: Product) {
    setProducts((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p))
    );
  }

  // ── Export ──
  function handleExport() {
    exportTranslatedCSV(products, rawRows, filename);
  }

  // ── Reset ──
  function handleReset() {
    if (confirm("Clear all products and upload a new file?")) {
      setProducts([]);
      setRawRows([]);
      setFilename("");
      setSelectedId(null);
      setError(null);
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  // ── Editor navigation ──
  const selectedIndex = selectedId
    ? products.findIndex((p) => p.id === selectedId)
    : -1;

  function handleNavigate(direction: "prev" | "next") {
    if (selectedIndex === -1) return;
    const next = direction === "prev" ? selectedIndex - 1 : selectedIndex + 1;
    if (next >= 0 && next < products.length) {
      setSelectedId(products[next].id);
    }
  }

  const isTranslatingAny = products.some((p) => p.isTranslating);
  const selectedProduct = selectedId
    ? products.find((p) => p.id === selectedId) ?? null
    : null;

  if (!hydrated) return null;

  // ── Editor view ──
  if (selectedProduct) {
    return (
      <ProductEditor
        key={selectedProduct.id}
        product={selectedProduct}
        productIndex={selectedIndex}
        totalProducts={products.length}
        shopifyEnabled={SHOPIFY_ENABLED}
        onSave={handleSave}
        onTranslate={handleTranslate}
        onSync={SHOPIFY_ENABLED ? handleSync : undefined}
        onPush={SHOPIFY_ENABLED ? handlePush : undefined}
        onBack={() => setSelectedId(null)}
        onNavigate={handleNavigate}
      />
    );
  }

  // ── List view ──
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-screen-xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <svg
                className="w-4 h-4 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900">Shopify CSV Translator</h1>
              <p className="text-xs text-gray-500">Russian → English · Powered by OpenAI</p>
            </div>
          </div>
          {filename && (
            <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5">
              <svg
                className="w-4 h-4 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span className="font-medium text-gray-700">{filename}</span>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-6 py-8">
        {/* Error banner */}
        {error && (
          <div className="mb-6 flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
            <svg
              className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div className="flex-1">
              <p className="font-semibold">Error</p>
              <p className="mt-0.5">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        )}

        {products.length === 0 ? (
          <div className="max-w-2xl mx-auto mt-16">
            <div className="text-center mb-10">
              <h2 className="text-3xl font-bold text-gray-900">Translate Shopify Products</h2>
              <p className="text-gray-500 mt-3 text-lg">
                Upload a Shopify product export CSV to translate titles, descriptions, and SEO
                fields from Russian to English.
              </p>
            </div>
            <UploadCSV onUpload={handleUpload} isLoading={isUploading} />
            <div className="mt-8 grid grid-cols-3 gap-4">
              {[
                { step: "1", title: "Upload CSV", desc: "Export products from Shopify admin" },
                {
                  step: "2",
                  title: "Translate",
                  desc: "AI translates each product, HTML preserved",
                },
                { step: "3", title: "Export", desc: "Download ready-to-import English CSV" },
              ].map((item) => (
                <div
                  key={item.step}
                  className="text-center p-4 rounded-xl bg-white border border-gray-200"
                >
                  <div className="w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-sm font-bold mx-auto mb-2">
                    {item.step}
                  </div>
                  <p className="font-semibold text-gray-800 text-sm">{item.title}</p>
                  <p className="text-xs text-gray-500 mt-1">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <ProductTable
            products={products}
            showUntranslatedOnly={showUntranslatedOnly}
            onOpenEditor={setSelectedId}
            onTranslate={handleTranslate}
            onTranslateAll={handleTranslateAll}
            onToggleFilter={() => setShowUntranslatedOnly((v) => !v)}
            onExport={handleExport}
            onReset={handleReset}
            isTranslatingAny={isTranslatingAny}
          />
        )}
      </main>
    </div>
  );
}
