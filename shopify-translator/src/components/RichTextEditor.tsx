"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  minRows?: number;
}

export default function RichTextEditor({
  value,
  onChange,
  disabled = false,
  placeholder = "Enter translation…",
  minRows = 8,
}: RichTextEditorProps) {
  const [mode, setMode] = useState<"rich" | "html">("rich");
  const [htmlDraft, setHtmlDraft] = useState(value);
  const [copied, setCopied] = useState(false);
  // Use a ref (not state) so the guard is synchronous — TipTap's onUpdate
  // fires synchronously inside setContent, before any React state update commits.
  const isSyncingRef = useRef(false);

  const editor = useEditor({
    extensions: [
      // StarterKit v3 already includes link + underline; configure link here only (no duplicate extensions)
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        dropcursor: false,
        link: { openOnClick: false },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: value || "",
    editable: !disabled,
    immediatelyRender: false,
    onUpdate({ editor }: { editor: { getHTML: () => string } }) {
      if (!isSyncingRef.current) {
        onChange(editor.getHTML());
      }
    },
  });

  // Sync incoming value to editor when parent updates (e.g. after translate)
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    // Only update if the value actually changed to avoid cursor jumps
    if (value !== current) {
      isSyncingRef.current = true;
      editor.commands.setContent(value || "", { emitUpdate: false });
      setHtmlDraft(value || "");
      isSyncingRef.current = false;
    }
  }, [value, editor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [disabled, editor]);

  // Switch from HTML mode back to rich mode.
  // Keep this as a pure view toggle (no parent write) so mode switching itself
  // never mutates/normalizes stored content.
  function switchToRich() {
    if (!editor) return;
    isSyncingRef.current = true;
    editor.commands.setContent(htmlDraft, { emitUpdate: false });
    isSyncingRef.current = false;
    setMode("rich");
  }

  function switchToHtml() {
    if (!editor) return;
    setHtmlDraft(editor.getHTML());
    setMode("html");
  }

  async function copyHtml() {
    const raw = mode === "html" ? htmlDraft : (editor?.getHTML() ?? value ?? "");
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors silently
    }
  }

  const minHeight = `${minRows * 1.75}rem`;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-400 focus-within:border-transparent transition-shadow">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 bg-gray-50 border-b border-gray-200 flex-wrap">
        {/* Compact controls: copy + source toggle */}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={copyHtml}
            disabled={disabled}
            className={`w-8 h-8 rounded-md inline-flex items-center justify-center transition-colors ${
              disabled
                ? "text-gray-300 cursor-not-allowed"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-100 cursor-pointer"
            }`}
            title="Copy raw HTML to clipboard"
            aria-label="Copy HTML"
          >
            {copied ? (
              <CheckSmallIcon />
            ) : (
              <img
                src="/copy-icon.png"
                alt=""
                aria-hidden="true"
                className="w-3.5 h-3.5 opacity-65"
              />
            )}
          </button>
          <button
            type="button"
            onClick={() => (mode === "html" ? switchToRich() : switchToHtml())}
            className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
              mode === "html"
                ? "bg-gray-800 border-gray-800 text-white"
                : "bg-white border-gray-200 text-gray-600 hover:bg-gray-100"
            }`}
            title={mode === "html" ? "Switch to rich view" : "Switch to HTML code view"}
            aria-label={mode === "html" ? "Switch to rich view" : "Switch to HTML code view"}
          >
            {"</>"}
          </button>
        </div>
      </div>

      {/* Editor content */}
      {mode === "rich" ? (
        <div
          className={`px-4 py-3 bg-white overflow-y-auto ${disabled ? "bg-gray-50 opacity-60" : ""}`}
          style={{ minHeight }}
        >
          <EditorContent
            editor={editor}
            className="prose prose-sm max-w-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror]:text-sm [&_.ProseMirror]:leading-relaxed [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-gray-300 [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none"
          />
        </div>
      ) : (
        <textarea
          value={htmlDraft}
          onChange={(e) => {
            setHtmlDraft(e.target.value);
            onChange(e.target.value);
          }}
          disabled={disabled}
          spellCheck={false}
          className="w-full px-4 py-3 text-sm font-mono bg-gray-900 text-green-400 focus:outline-none resize-y disabled:opacity-60"
          style={{ minHeight }}
        />
      )}
    </div>
  );
}

function CheckSmallIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}
