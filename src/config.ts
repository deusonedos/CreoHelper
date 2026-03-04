import "dotenv/config";
import { assert, clamp, parseCsvNumberList } from "./utils";

export type Config = {
  telegramBotToken: string;
  allowedTelegramUserIds: Set<number>;

  openRouterApiKey: string;
  openRouterModel: string;

  apifyApiToken: string;
  apifyActorId: string;
  apifyRegion: string;
  apifyMaxResults: number;

  sttApiKey: string;
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

  const allowedTelegramUserIds = new Set(parseCsvNumberList(env("ALLOWED_TELEGRAM_USER_IDS")));

  // Speech-to-text is OpenAI-compatible (Whisper).
  // Prefer STT_API_KEY; keep OPENAI_API_KEY for backward compatibility.
  const sttApiKey = env("STT_API_KEY") ?? env("OPENAI_API_KEY") ?? "";
  const sttEndpoint = env("STT_ENDPOINT") ?? "https://api.openai.com/v1/audio/transcriptions";
  const sttModel = env("STT_MODEL") ?? "whisper-1";

  const openRouterModel = env("OPENROUTER_MODEL") ?? "openai/gpt-4o-mini";

  const apifyActorId = env("APIFY_ACTOR_ID") ?? "sociavault/tiktok-keyword-search-scraper";
  const apifyRegion = env("APIFY_REGION") ?? "US";
  const apifyMaxResults = clamp(Number(env("APIFY_MAX_RESULTS") ?? "50"), 1, 200);

  assert(telegramBotToken, "Missing TELEGRAM_BOT_TOKEN");
  assert(openRouterApiKey, "Missing OPENROUTER_API_KEY");
  assert(apifyApiToken, "Missing APIFY_API_TOKEN");
  assert(allowedTelegramUserIds.size > 0, "Missing/empty ALLOWED_TELEGRAM_USER_IDS (e.g. 123,456)");

  // Whisper STT is required for voice notes (MVP requirement).
  assert(sttApiKey, "Missing STT_API_KEY (or OPENAI_API_KEY) required for voice transcription");

  return {
    telegramBotToken,
    allowedTelegramUserIds,
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

