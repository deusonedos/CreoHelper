import { Bot, GrammyError, HttpError } from "grammy";
import { loadConfig } from "./config";
import { sleep, withChatLock } from "./utils";
import { downloadTelegramFileToTemp, transcribeWithWhisper } from "./speech";
import { generateKeywordsOpenRouter } from "./llm";
import { searchTikTokByKeywordViaApify, splitAndSortByViews } from "./apify";
import { formatHelp, formatResultMessage, type KeywordBlock } from "./format";

const config = loadConfig();
const bot = new Bot(config.telegramBotToken);

// Minimal debug logs (server-side only). Helps verify updates reach the bot and see from.id.
bot.use(async (ctx, next) => {
  try {
    const text = (ctx.message as any)?.text;
    const isCommand = typeof text === "string" && text.startsWith("/");
    const isFind = typeof text === "string" && /^\/find(@\w+)?\b/i.test(text);
    const voice = (ctx.message as any)?.voice;
    const isVoice = !!voice;
    const isPlainText =
      config.textTriggerMode === "all_text" && typeof text === "string" && text.trim() && !text.startsWith("/");
    if (isCommand || isFind || isVoice || isPlainText) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          fromId: ctx.from?.id ?? null,
          chatId: ctx.chat?.id ?? null,
          chatType: (ctx.chat as any)?.type ?? null,
          kind: isVoice ? "voice" : "text",
          text: typeof text === "string" ? text.slice(0, 200) : null,
          voice: isVoice ? { duration: voice.duration, fileId: voice.file_id } : null,
        })
      );
    }
  } catch {
    // ignore logging errors
  }
  await next();
});

function isGroupChat(type: unknown): boolean {
  return type === "group" || type === "supergroup";
}

function userFacingErrorMessage(e: unknown): string {
  const msg = String((e as any)?.message ?? e ?? "").toLowerCase();
  if (msg.includes("apify")) return "Не смог получить результаты, попробуй позже.";
  if (msg.includes("openrouter")) return "Не смог сгенерировать ключевики, попробуй ещё раз.";
  return "Ошибка: не смог обработать запрос. Попробуй позже.";
}

async function runPipeline(opts: {
  chatId: number;
  replyToMessageId?: number;
  queryText: string;
  originalQueryLabel?: string;
}): Promise<{ text: string; hadAnyResults: boolean }> {
  const keywordsRes = await generateKeywordsOpenRouter({
    apiKey: config.openRouterApiKey,
    model: config.openRouterModel,
    query: opts.queryText,
  });

  const perKeywordTop = 5;
  const totalLimit = 30;

  const blocks: KeywordBlock[] = [];
  let anyVideos = false;

  for (const keyword of keywordsRes.keywords) {
    const items = await searchTikTokByKeywordViaApify({
      apiToken: config.apifyApiToken,
      actorId: config.apifyActorId,
      keyword,
      region: config.apifyRegion,
      maxResults: config.apifyMaxResults,
    });

    const { withDate, withoutDate } = splitAndSortByViews(items);
    const top = withDate.slice(0, perKeywordTop);
    const topFallback = withoutDate.slice(0, Math.max(0, perKeywordTop - top.length));

    if (top.length || topFallback.length) anyVideos = true;

    blocks.push({
      keyword,
      videos: top,
      unknownDateVideos: topFallback,
    });
  }

  const text = formatResultMessage({
    originalQuery: opts.originalQueryLabel ? `${opts.originalQueryLabel}\n${opts.queryText}` : opts.queryText,
    keywords: keywordsRes.keywords,
    blocks,
    totalLimit,
  });

  return { text, hadAnyResults: anyVideos };
}

bot.command("help", async (ctx) => {
  if (!isGroupChat((ctx.chat as any)?.type)) return;
  await ctx.reply(formatHelp(bot.botInfo?.username), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

bot.command("diag", async (ctx) => {
  if (!isGroupChat((ctx.chat as any)?.type)) return;
  const lines = [
    "<b>Diag</b>",
    `- from.id: <code>${ctx.from?.id ?? "?"}</code>`,
    `- chat.id: <code>${ctx.chat?.id ?? "?"}</code>`,
    `- chat.type: <code>${(ctx.chat as any)?.type ?? "?"}</code>`,
    `- bot: <code>@${bot.botInfo?.username ?? "unknown"}</code>`,
    `- text.trigger: <code>${config.textTriggerMode}</code>`,
    `- voice.enabled: <code>no</code>`,
    `- stt.configured: <code>${config.sttApiKey ? "yes" : "no"}</code>`,
    `- openrouter.model: <code>${config.openRouterModel}</code>`,
    `- apify.actor: <code>${config.apifyActorId}</code>`,
    `- apify.region: <code>${config.apifyRegion}</code>`,
    `- apify.maxResults: <code>${config.apifyMaxResults}</code>`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});

bot.on("message:text", async (ctx) => {
  // Optional mode: handle any text from allowed users.
  if (config.textTriggerMode !== "all_text") return;
  if (ctx.from?.is_bot) return;
  if (!isGroupChat((ctx.chat as any)?.type)) return;

  const text = ctx.message?.text?.trim() ?? "";
  if (!text) return;
  // Let explicit commands be handled by their command handlers.
  if (text.startsWith("/")) return;

  await withChatLock(ctx.chat.id, async () => {
    const replyTo = ctx.message?.message_id;
    const status = await ctx.reply("⏳ Ищу TikTok креативы…", {
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });
    try {
      const { text: out, hadAnyResults } = await runPipeline({
        chatId: ctx.chat.id,
        replyToMessageId: replyTo,
        queryText: text,
      });

      if (!hadAnyResults) {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Ничего не нашёл по этим ключам 😕", {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      await ctx.api.editMessageText(ctx.chat.id, status.message_id, out, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      console.error("Pipeline error (all_text):", e);
      const msg = userFacingErrorMessage(e);
      try {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, msg);
      } catch {
        await ctx.reply(msg, {
          reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
        });
      }
    }
  });
});

bot.command("find", async (ctx) => {
  if (!isGroupChat((ctx.chat as any)?.type)) return;

  const raw = ctx.message?.text ?? "";
  const query = raw.replace(/^\/find(@\w+)?\s*/i, "").trim();
  if (!query) {
    await ctx.reply("Напиши так: <code>/find твой запрос</code>", { parse_mode: "HTML" });
    return;
  }

  await withChatLock(ctx.chat.id, async () => {
    const replyTo = ctx.message?.message_id;
    const status = await ctx.reply("⏳ Ищу TikTok креативы…", {
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });
    try {
      const { text, hadAnyResults } = await runPipeline({
        chatId: ctx.chat.id,
        replyToMessageId: replyTo,
        queryText: query,
      });

      if (!hadAnyResults) {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Ничего не нашёл по этим ключам 😕", {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      await ctx.api.editMessageText(ctx.chat.id, status.message_id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      console.error("Pipeline error (/find):", e);
      const msg = userFacingErrorMessage(e);
      try {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, msg);
      } catch {
        await ctx.reply(msg, {
          reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
        });
      }
    }
  });
});

bot.on("message:voice", async (ctx) => {
  if (!isGroupChat((ctx.chat as any)?.type)) return;

  // MVP for now: text only.
  const replyTo = ctx.message?.message_id;
  await ctx.reply("Пока работаю только с текстом. Напиши запрос сообщением.", {
    reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
  });
  return;

  await withChatLock(ctx.chat.id, async () => {
    const replyTo = ctx.message?.message_id;
    const status = await ctx.reply("🎙️ Распознаю голос…", {
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });

    try {
      if (!config.sttApiKey) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          "Голосовые сейчас отключены: добавь STT_API_KEY (OpenAI-compatible) в Railway Variables.",
          { link_preview_options: { is_disabled: true } }
        );
        return;
      }

      const fileId = ctx.message?.voice?.file_id;
      if (!fileId) throw new Error("No voice file_id");

      const tgFile = await ctx.api.getFile(fileId);
      const filePath = tgFile.file_path;
      if (!filePath) throw new Error("Telegram getFile returned empty file_path");

      const { localPath, cleanup } = await downloadTelegramFileToTemp({
        botToken: config.telegramBotToken,
        filePath,
      });

      let transcript = "";
      try {
        transcript = await transcribeWithWhisper({
          apiKey: config.sttApiKey,
          endpoint: config.sttEndpoint,
          model: config.sttModel,
          filePath: localPath,
          // Most of the time we speak Russian in the group; this improves STT.
          languageHint: "ru",
        });
      } finally {
        await cleanup().catch(() => undefined);
      }

      await ctx.api.editMessageText(ctx.chat.id, status.message_id, "⏳ Ищу TikTok креативы…", {
        link_preview_options: { is_disabled: true },
      });

      const { text, hadAnyResults } = await runPipeline({
        chatId: ctx.chat.id,
        replyToMessageId: replyTo,
        queryText: transcript,
        originalQueryLabel: "STT",
      });

      if (!hadAnyResults) {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Ничего не нашёл по этим ключам 😕", {
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      await ctx.api.editMessageText(ctx.chat.id, status.message_id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      console.error("Voice handler error:", e);

      const msg = String(e?.message ?? e);
      const isStt = msg.toLowerCase().includes("whisper") || msg.toLowerCase().includes("transcription");

      const out = isStt ? "Не смог распознать голос, попробуй ещё раз." : userFacingErrorMessage(e);

      try {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, out);
      } catch {
        await ctx.reply(out, {
          reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
        });
      }
    }
  });
});

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Telegram API error:", e.description);
  } else if (e instanceof HttpError) {
    console.error("HTTP error:", e);
  } else {
    console.error("Unknown error:", e);
  }
});

async function startLongPollingWithRetry() {
  // Ensure webhook is disabled (we use long polling on Railway).
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.warn("deleteWebhook failed (ignored):", e);
  }

  console.log("Bot starting…");
  // Railway deploys can briefly run two instances; handle 409 by retrying.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await bot.start({ drop_pending_updates: true });
      return;
    } catch (e: any) {
      const code = e?.error_code ?? e?.payload?.error_code;
      const msg = String(e?.message ?? e ?? "");
      if (code === 409 || msg.includes("409") || msg.toLowerCase().includes("getupdates")) {
        const waitMs = Math.min(30_000, 1000 * attempt);
        console.warn(`Long polling conflict (409). Retrying in ${waitMs}ms…`);
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to start bot after multiple retries (getUpdates conflict).");
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}, stopping bot…`);
  try {
    await bot.stop();
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

startLongPollingWithRetry().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});

