"use client";

import { Product } from "@/types";
import ProductRow from "@/components/ProductRow";

interface ProductTableProps {
  products: Product[];
  showUntranslatedOnly: boolean;
  isTranslatingAny: boolean;
  onOpenEditor: (id: string) => void;
  onTranslate: (id: string) => void;
  onTranslateAll: () => void;
  onToggleFilter: () => void;
  onExport: () => void;
  onReset: () => void;
}

export default function ProductTable({
  products,
  showUntranslatedOnly,
  isTranslatingAny,
  onOpenEditor,
  onTranslate,
  onTranslateAll,
  onToggleFilter,
  onExport,
  onReset,
}: ProductTableProps) {
  const visible = showUntranslatedOnly
    ? products.filter((p) => p.status !== "translated")
    : products;

  const translatedCount = products.filter((p) => p.status === "translated").length;
  const total = products.length;
  const allDone = translatedCount === total;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">
            <span className="font-semibold text-gray-800">{translatedCount}</span> / {total} translated
          </span>
          <button
            onClick={onToggleFilter}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
              showUntranslatedOnly
                ? "bg-amber-50 border-amber-300 text-amber-700"
                : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"
            }`}
          >
            {showUntranslatedOnly ? "Showing untranslated" : "Show all"}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onReset}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-red-300 hover:text-red-600 transition-colors"
          >
            Reset
          </button>
          <button
            onClick={onTranslateAll}
            disabled={isTranslatingAny || allDone}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all border ${
              isTranslatingAny || allDone
                ? "bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-white border-indigo-300 text-indigo-600 hover:bg-indigo-50"
            }`}
          >
            {isTranslatingAny ? "Translating…" : allDone ? "All translated" : "Translate all"}
          </button>
          <button
            onClick={onExport}
            disabled={translatedCount === 0}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              translatedCount === 0
                ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                : "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
            }`}
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
          <div
            className="bg-emerald-500 h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${(translatedCount / total) * 100}%` }}
          />
        </div>
      )}

      {/* Rows */}
      <div className="space-y-2">
        {visible.length === 0 ? (
          <div className="text-center py-12 text-sm text-gray-400">
            {showUntranslatedOnly ? "All products are translated!" : "No products found."}
          </div>
        ) : (
          visible.map((product, i) => (
            <ProductRow
              key={product.id}
              product={product}
              index={i}
              onClick={onOpenEditor}
              onTranslate={onTranslate}
            />
          ))
        )}
      </div>
    </div>
  );
}
