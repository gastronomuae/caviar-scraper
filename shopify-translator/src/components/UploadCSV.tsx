"use client";

import { useRef, useState } from "react";

interface UploadCSVProps {
  onUpload: (file: File) => void;
  isLoading: boolean;
}

export default function UploadCSV({ onUpload, isLoading }: UploadCSVProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFile(file: File) {
    if (!file.name.endsWith(".csv")) {
      alert("Please upload a .csv file.");
      return;
    }
    onUpload(file);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !isLoading && inputRef.current?.click()}
      className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all
        ${dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300 hover:border-blue-400 hover:bg-gray-50"}
        ${isLoading ? "opacity-60 cursor-not-allowed" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={handleChange}
        disabled={isLoading}
      />
      <div className="flex flex-col items-center gap-3">
        <svg
          className={`w-12 h-12 ${dragOver ? "text-blue-500" : "text-gray-400"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
        <div>
          <p className="text-lg font-semibold text-gray-700">
            {isLoading ? "Parsing CSV..." : "Drop your Shopify CSV here"}
          </p>
          <p className="text-sm text-gray-500 mt-1">
            or click to browse — supports Shopify product export format
          </p>
        </div>
      </div>
    </div>
  );
}
