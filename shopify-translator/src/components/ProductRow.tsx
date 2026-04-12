"use client";

import { Product } from "@/types";

interface ProductRowProps {
  product: Product;
  index: number;
  onClick: (id: string) => void;
  onTranslate: (id: string) => void;
}

export default function ProductRow({ product, index, onClick, onTranslate }: ProductRowProps) {
  const isTranslating = product.isTranslating ?? false;
  const isTranslated = product.status === "translated";

  const bodySnippet = product.ru_body
    ? product.ru_body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
    : null;

  return (
    <div
      onClick={() => onClick(product.id)}
      className="group flex items-center gap-4 bg-white border border-gray-200 rounded-xl px-5 py-4 cursor-pointer hover:border-blue-300 hover:shadow-md transition-all"
    >
      {/* Index */}
      <span className="text-xs text-gray-300 font-mono w-6 shrink-0 text-right">{index + 1}</span>

      {/* Status dot */}
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${
          isTranslating
            ? "bg-blue-400 animate-pulse"
            : isTranslated
            ? "bg-green-400"
            : "bg-amber-400"
        }`}
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">
          {product.ru_title || <span className="text-gray-400 font-normal italic">No title</span>}
        </p>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-gray-400 font-mono truncate max-w-[160px]">{product.handle}</span>
          {bodySnippet && (
            <span className="text-xs text-gray-400 truncate">{bodySnippet}…</span>
          )}
        </div>
      </div>

      {/* EN title preview */}
      {isTranslated && product.en_title && (
        <div className="hidden lg:block max-w-[220px] shrink-0">
          <p className="text-xs text-gray-500 truncate">{product.en_title}</p>
        </div>
      )}

      {/* Status badge */}
      <div className="shrink-0">
        {isTranslating ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-600">
            <Spinner /> Translating…
          </span>
        ) : isTranslated ? (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
            Translated
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
            Untranslated
          </span>
        )}
      </div>

      {/* Translate quick-action */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onTranslate(product.id);
        }}
        disabled={isTranslating}
        title={isTranslated ? "Re-translate" : "Translate"}
        className={`shrink-0 p-2 rounded-lg border transition-all
          ${isTranslating
            ? "border-transparent text-gray-300 cursor-not-allowed"
            : "border-gray-200 text-gray-400 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 opacity-0 group-hover:opacity-100"
          }`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
        </svg>
      </button>

      {/* Open arrow */}
      <svg
        className="w-4 h-4 text-gray-300 group-hover:text-gray-500 shrink-0 transition-colors"
        fill="none" viewBox="0 0 24 24" stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
