import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const SYSTEM_PROMPT = `You are a professional e-commerce copywriter and translator.
Translate product content from Russian to English.
Rules:
- Preserve all HTML tags, attributes, and structure exactly as-is
- Only translate the visible text content within the HTML
- Use natural, SEO-friendly e-commerce English
- Keep product names, brand names, and model numbers unchanged
- Maintain the same tone (professional, descriptive, retail-focused)
- Do not add or remove any HTML elements
- Return ONLY the translated content, no explanations`;

type TranslationTask = {
  text: string;
  type: "plain" | "html" | "seo_title" | "seo_desc";
};

async function runTranslation(
  openai: OpenAI,
  task: TranslationTask
): Promise<string> {
  const prompts: Record<TranslationTask["type"], string> = {
    plain: `Translate this product text from Russian to English (plain text only, no HTML):\n\n${task.text}`,
    html: `Translate this product description from Russian to English. Preserve ALL HTML tags and attributes exactly as-is, only translate text content:\n\n${task.text}`,
    seo_title: `Translate this SEO meta title from Russian to English. Keep it concise (under 60 characters), SEO-optimized, plain text:\n\n${task.text}`,
    seo_desc: `Translate this SEO meta description from Russian to English. Keep it under 160 characters, compelling and SEO-friendly, plain text:\n\n${task.text}`,
  };

  const maxTokens: Record<TranslationTask["type"], number> = {
    plain: 200,
    html: 2000,
    seo_title: 100,
    seo_desc: 300,
  };

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompts[task.type] },
    ],
    temperature: 0.3,
    max_tokens: maxTokens[task.type],
  });

  return result.choices[0]?.message?.content?.trim() ?? "";
}

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 500 }
    );
  }

  let ru_title: string;
  let ru_body: string;
  let ru_meta_title: string;
  let ru_meta_description: string;
  /** Generic synced fields (image alts, etc.) from the Translations API */
  let syncedFieldsInput: Array<{ key: string; value: string }>;

  try {
    const body = await req.json();
    ru_title = body.ru_title ?? "";
    ru_body = body.ru_body ?? "";
    ru_meta_title = body.ru_meta_title ?? "";
    ru_meta_description = body.ru_meta_description ?? "";
    syncedFieldsInput = Array.isArray(body.syncedFields) ? body.syncedFields : [];
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const hasContent =
    ru_title ||
    ru_body ||
    ru_meta_title ||
    ru_meta_description ||
    syncedFieldsInput.some((f) => f.value);

  if (!hasContent) {
    return NextResponse.json(
      { error: "All fields are empty — nothing to translate" },
      { status: 400 }
    );
  }

  try {
    const openai = getOpenAIClient();

    // Translate CSV core fields + all synced fields in one parallel batch
    const [en_title, en_body, en_meta_title, en_meta_description, ...syncedResults] =
      await Promise.all([
        ru_title
          ? runTranslation(openai, { text: ru_title, type: "plain" })
          : Promise.resolve(""),
        ru_body
          ? runTranslation(openai, { text: ru_body, type: "html" })
          : Promise.resolve(""),
        ru_meta_title
          ? runTranslation(openai, { text: ru_meta_title, type: "seo_title" })
          : Promise.resolve(""),
        ru_meta_description
          ? runTranslation(openai, { text: ru_meta_description, type: "seo_desc" })
          : Promise.resolve(""),
        ...syncedFieldsInput.map((f) =>
          f.value
            ? runTranslation(openai, { text: f.value, type: "plain" })
            : Promise.resolve("")
        ),
      ]);

    // Zip synced keys with their translated values
    const translatedSyncedFields = syncedFieldsInput.map((f, i) => ({
      key: f.key,
      translatedValue: syncedResults[i] ?? "",
    }));

    return NextResponse.json({
      en_title,
      en_body,
      en_meta_title,
      en_meta_description,
      translatedSyncedFields,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Translation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
