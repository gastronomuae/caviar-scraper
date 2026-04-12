/**
 * Shared UI primitives — single source of truth for button styles across all editors.
 *
 * Variants
 *   primary   — Shopify green CTA  (Push to Shopify)
 *   secondary — white/gray outline (Save, Undo)
 *   translate — blue tint          (Translate missing / Re-translate)
 *   danger    — red tint            (Discard, Delete)
 *
 * To change the look of every "Push" button across the app, edit the `primary`
 * branch here. Same for every "Translate missing" button (edit `translate`), etc.
 */

import React from "react";

// ─── Spinner ──────────────────────────────────────────────────────────────────

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin w-4 h-4 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12" cy="12" r="10"
        stroke="currentColor" strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

// ─── AppButton ────────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "translate" | "blue" | "danger";

interface AppButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingText?: string;
  size?: "sm" | "md";
}

const BASE =
  "inline-flex items-center gap-2 font-semibold rounded-xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1";

const SIZE: Record<"sm" | "md", string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2.5 text-sm",
};

const VARIANT_ENABLED: Record<ButtonVariant, string> = {
  primary:   "bg-[#008060] text-white border border-[#008060] hover:bg-[#006e52] shadow-sm focus-visible:ring-[#008060]",
  secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 shadow-sm focus-visible:ring-gray-300",
  translate: "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 focus-visible:ring-blue-300",
  blue:      "bg-blue-600 text-white border border-blue-600 hover:bg-blue-700 shadow-sm focus-visible:ring-blue-500",
  danger:    "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 focus-visible:ring-red-300",
};

const VARIANT_LOADING: Record<ButtonVariant, string> = {
  primary:   "bg-[#008060]/60 text-white border border-[#008060]/40 cursor-not-allowed",
  secondary: "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed",
  translate: "bg-blue-50 text-blue-400 border border-blue-200 cursor-not-allowed",
  blue:      "bg-blue-400 text-white border border-blue-400 cursor-not-allowed",
  danger:    "bg-red-50 text-red-300 border border-red-200 cursor-not-allowed",
};

const VARIANT_DISABLED: Record<ButtonVariant, string> = {
  primary:   "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed",
  secondary: "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed",
  translate: "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed",
  blue:      "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed",
  danger:    "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed",
};

export function AppButton({
  variant = "secondary",
  loading = false,
  loadingText,
  size = "md",
  disabled,
  className = "",
  children,
  ...rest
}: AppButtonProps) {
  const isDisabled = disabled || loading;

  let stateClass: string;
  if (loading) {
    stateClass = VARIANT_LOADING[variant];
  } else if (isDisabled) {
    stateClass = VARIANT_DISABLED[variant];
  } else {
    stateClass = VARIANT_ENABLED[variant];
  }

  return (
    <button
      disabled={isDisabled}
      className={`${BASE} ${SIZE[size]} ${stateClass} ${className}`}
      {...rest}
    >
      {loading ? (
        <>
          <Spinner />
          {loadingText ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// ─── MissingBadge ─────────────────────────────────────────────────────────────

/** Amber pill showing "N missing" — used in editor headers. */
export function MissingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full font-medium shrink-0 tabular-nums">
      {count} missing
    </span>
  );
}

// ─── UnsavedBadge ─────────────────────────────────────────────────────────────

/** Amber pill shown when there are unsaved local edits. */
export function UnsavedBadge() {
  return (
    <span className="text-xs text-amber-600 font-medium bg-amber-50 border border-amber-200 px-2 py-1 rounded-md">
      Unsaved
    </span>
  );
}

// ─── TypeChip ─────────────────────────────────────────────────────────────────

/**
 * Coloured resource-type label chip (e.g. "Theme", "Menu", "Product").
 * colour defaults to violet (theme); pass a Tailwind bg+text+border set to override.
 */
export function TypeChip({
  label,
  colorClass = "bg-violet-100 text-violet-800 border-violet-200/80",
}: {
  label: string;
  colorClass?: string;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${colorClass}`}
    >
      {label}
    </span>
  );
}

// ─── Icon helpers (shared across editors) ────────────────────────────────────

export function TranslateIcon({ size = "sm" }: { size?: "xs" | "sm" }) {
  const cls = size === "xs" ? "w-3 h-3" : "w-4 h-4";
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
    </svg>
  );
}

export function RefreshIcon({ size = "sm" }: { size?: "xs" | "sm" }) {
  const cls = size === "xs" ? "w-3 h-3" : "w-4 h-4";
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

// ─── BackButton ───────────────────────────────────────────────────────────────

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 transition-colors shrink-0"
      title="Back"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      Back
    </button>
  );
}
