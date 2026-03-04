import { uniqueStrings } from "./utils";

export type KeywordResult = {
  keywords: string[];
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

function extractJsonObject(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

export async function generateKeywordsOpenRouter(opts: {
  apiKey: string;
  model: string;
  query: string;
}): Promise<KeywordResult> {
  const system = [
    "You generate TikTok search keywords for creative research.",
    "Return ONLY a valid JSON object, no markdown, no extra text.",
    'Schema: {"keywords": ["...","...","...","...","..."]}',
    "Keywords must be in English by default, 2-5 words each, highly searchable.",
  ].join("\n");

  const user = [
    "Task:",
    "Generate exactly 5 TikTok search keywords for the request below.",
    "Avoid quotes inside keywords. Avoid emojis.",
    "",
    "Request:",
    opts.query,
  ].join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as OpenRouterChatResponse;
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("OpenRouter returned empty content");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const maybeJson = extractJsonObject(content);
    if (!maybeJson) throw new Error(`Failed to parse OpenRouter JSON: ${content.slice(0, 500)}`);
    parsed = JSON.parse(maybeJson);
  }

  const keywordsRaw = (parsed as any)?.keywords;
  if (!Array.isArray(keywordsRaw)) throw new Error(`Invalid OpenRouter response shape: ${content.slice(0, 500)}`);

  const keywords = uniqueStrings(
    keywordsRaw
      .map((k: unknown) => (typeof k === "string" ? k : ""))
      .map((k) => k.replaceAll(/\s+/g, " ").trim())
  ).slice(0, 5);

  if (keywords.length < 3) throw new Error(`Too few keywords generated: ${content.slice(0, 500)}`);

  return { keywords };
}

