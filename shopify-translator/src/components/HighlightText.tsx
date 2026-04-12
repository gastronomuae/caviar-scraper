"use client";

interface HighlightTextProps {
  text: string;
  query: string;
  className?: string;
}

/**
 * Renders text with all occurrences of `query` wrapped in a <mark> highlight.
 * Case-insensitive, partial match.
 */
export default function HighlightText({ text, query, className }: HighlightTextProps) {
  if (!query.trim() || !text) {
    return <span className={className}>{text}</span>;
  }

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");
  const parts = text.split(regex);

  return (
    <span className={className}>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark
            key={i}
            className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5 not-italic font-semibold"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}
