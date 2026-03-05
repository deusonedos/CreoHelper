import { uniqueStrings } from "./utils";

export type AssistantResult = {
  answer: string;
  language: string; // e.g. "en", "ar", "ru"
  propose_keywords: boolean;
  keywords: string[]; // empty if no proposal
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

export async function generateAssistantOpenRouter(opts: {
  apiKey: string;
  model: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  forceKeywords?: boolean;
}): Promise<AssistantResult> {
  const system = [
    "You are a helpful assistant helping a team find TikTok creatives.",
    "You are chatting in a Telegram group; be concise and practical.",
    "Maintain conversation context: if the user says 'go deeper' or 'refine', refine based on earlier topic.",
    "",
    "Output must be ONLY valid JSON (no markdown).",
    'Schema: {"answer":"...","language":"en|ru|ar|...","propose_keywords":true|false,"keywords":[...]}',
    "",
    "When to propose keywords:",
    "- If the user asks for keywords, search terms, key phrases, or to refine keywords: propose_keywords=true and output EXACTLY 5 keywords.",
    "- If the user asks to search TikTok or says 'use these keywords': propose_keywords=true and output EXACTLY 5 keywords.",
    "- Otherwise: propose_keywords=false and keywords must be an empty array [].",
    "",
    "Keyword language rules:",
    "- Default keyword language is English.",
    "- If the user explicitly asks for a specific language (e.g. Arabic) OR uses that script, generate keywords in that language.",
    "- Do NOT translate keywords to English if the user asked for Arabic (or any other language).",
    "",
    "Keyword formatting:",
    "- Each keyword: 1-5 words.",
    "- Avoid quotes inside keywords. Avoid emojis inside keywords.",
  ].join("\n");

  const chatMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    ...(opts.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
  ];

  if (opts.forceKeywords) {
    chatMessages.push({
      role: "system",
      content: "Force keywords proposal now: propose_keywords=true and output EXACTLY 5 keywords.",
    });
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      messages: chatMessages,
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

  const answerRaw = (parsed as any)?.answer;
  const languageRaw = (parsed as any)?.language;
  const proposeRaw = (parsed as any)?.propose_keywords;
  const keywordsRaw = (parsed as any)?.keywords;

  const keywordsArr = Array.isArray(keywordsRaw) ? keywordsRaw : [];
  const keywords = uniqueStrings(
    keywordsArr.map((k: unknown) => (typeof k === "string" ? k : "")).map((k) => k.replaceAll(/\s+/g, " ").trim())
  ).slice(0, 5);

  const propose_keywords = typeof proposeRaw === "boolean" ? proposeRaw : keywords.length > 0;
  if (propose_keywords && keywords.length !== 5) {
    throw new Error(`Expected exactly 5 keywords when propose_keywords=true: ${content.slice(0, 500)}`);
  }

  const answer = typeof answerRaw === "string" && answerRaw.trim() ? answerRaw.trim() : "Ок.";
  const language =
    typeof languageRaw === "string" && languageRaw.trim() ? languageRaw.trim().slice(0, 12) : "en";

  return { answer, keywords, language, propose_keywords };
}

// Backward-compatible helper for code paths that just need keywords right now.
export async function generateKeywordsOpenRouter(opts: {
  apiKey: string;
  model: string;
  query: string;
}): Promise<AssistantResult> {
  return await generateAssistantOpenRouter({
    apiKey: opts.apiKey,
    model: opts.model,
    messages: [{ role: "user", content: opts.query }],
    forceKeywords: true,
  });
}

