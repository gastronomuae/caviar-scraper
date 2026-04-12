import type { ShopifyResourceStatus } from "@/types";

const LABELS: Record<ShopifyResourceStatus, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  ARCHIVED: "Archived",
};

const STYLES: Record<ShopifyResourceStatus, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-800 border-emerald-200",
  DRAFT: "bg-amber-50 text-amber-900 border-amber-200",
  ARCHIVED: "bg-slate-100 text-slate-600 border-slate-200",
};

export default function ResourceStatusBadge({
  status,
  className = "",
}: {
  status: ShopifyResourceStatus;
  className?: string;
}) {
  return (
    <span
      title={`Shopify: ${LABELS[status]}`}
      className={`inline-flex shrink-0 items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${STYLES[status]} ${className}`}
    >
      {LABELS[status]}
    </span>
  );
}
