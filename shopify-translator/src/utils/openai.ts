import { TranslateRequestField, TranslateResponseField } from "@/types";

export interface TranslationSettings {
  model?: string;
  systemPrompt?: string;
  glossary?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

export async function translateFields(
  fields: TranslateRequestField[],
  settings?: TranslationSettings
): Promise<TranslateResponseField[]> {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields, ...settings }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error ?? `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.fields as TranslateResponseField[];
}
