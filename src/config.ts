import "dotenv/config";
import { assert, clamp } from "./utils";

export type Config = {
  telegramBotToken: string;

  textTriggerMode: "find_only" | "all_text";

  openRouterApiKey: string;
  openRouterModel: string;

  apifyApiToken: string;
  apifyActorId: string;
  apifyRegion: string;
  apifyMaxResults: number;

  sttApiKey: string | null;
  sttEndpoint: string;
  sttModel: string;
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function loadConfig(): Config {
  const telegramBotToken = env("TELEGRAM_BOT_TOKEN");
  const openRouterApiKey = env("OPENROUTER_API_KEY");
  const apifyApiToken = env("APIFY_API_TOKEN");

  // For MVP we handle any text by default.
  const textTriggerMode = (env("TEXT_TRIGGER_MODE") ?? "all_text") as string;

  // Speech-to-text is OpenAI-compatible (Whisper).
  // Prefer STT_API_KEY; keep OPENAI_API_KEY for backward compatibility.
  const sttApiKey = env("STT_API_KEY") ?? env("OPENAI_API_KEY") ?? null;
  const sttEndpoint = env("STT_ENDPOINT") ?? "https://api.openai.com/v1/audio/transcriptions";
  const sttModel = env("STT_MODEL") ?? "whisper-1";

  const openRouterModel = env("OPENROUTER_MODEL") ?? "openai/gpt-4o-mini";

  const apifyActorId = env("APIFY_ACTOR_ID") ?? "sociavault/tiktok-keyword-search-scraper";
  const apifyRegion = env("APIFY_REGION") ?? "US";
  const apifyMaxResults = clamp(Number(env("APIFY_MAX_RESULTS") ?? "50"), 1, 200);

  assert(telegramBotToken, "Missing TELEGRAM_BOT_TOKEN");
  assert(openRouterApiKey, "Missing OPENROUTER_API_KEY");
  assert(apifyApiToken, "Missing APIFY_API_TOKEN");

  if (textTriggerMode !== "find_only" && textTriggerMode !== "all_text") {
    throw new Error('Invalid TEXT_TRIGGER_MODE. Use "find_only" or "all_text".');
  }

  return {
    telegramBotToken,
    textTriggerMode: textTriggerMode as Config["textTriggerMode"],
    openRouterApiKey,
    openRouterModel,
    apifyApiToken,
    apifyActorId,
    apifyRegion,
    apifyMaxResults,
    sttApiKey,
    sttEndpoint,
    sttModel,
  };
}

