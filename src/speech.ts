import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import FormData from "form-data";

export async function downloadTelegramFileToTemp(opts: {
  botToken: string;
  filePath: string; // Telegram file_path
}): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
  const url = `https://api.telegram.org/file/bot${opts.botToken}/${opts.filePath}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to download Telegram file (${res.status}): ${body.slice(0, 200)}`);
  }

  const ext = path.extname(opts.filePath) || ".ogg";
  const localPath = path.join(os.tmpdir(), `tg-voice-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);

  const nodeStream = Readable.fromWeb(res.body as any);
  await pipeline(nodeStream, fs.createWriteStream(localPath));

  return {
    localPath,
    cleanup: async () => {
      await fsp.rm(localPath, { force: true });
    },
  };
}

export async function transcribeWithWhisper(opts: {
  apiKey: string;
  endpoint: string; // OpenAI-compatible /audio/transcriptions
  model: string;
  filePath: string;
  languageHint?: string; // e.g. "ru"
}): Promise<string> {
  const form = new FormData();
  form.append("file", fs.createReadStream(opts.filePath));
  form.append("model", opts.model);
  form.append("response_format", "json");
  // Optional hints. Even if speech is RU, we want query text as-is.
  if (opts.languageHint) form.append("language", opts.languageHint);

  const res = await fetch(opts.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      ...(form.getHeaders() as Record<string, string>),
    },
    body: form as any,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whisper STT error ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as any;
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("Whisper returned empty transcription");
  return text;
}

