import { Bot, GrammyError, HttpError } from "grammy";
import { loadConfig } from "./config";
import { withChatLock } from "./utils";
import { downloadTelegramFileToTemp, transcribeWithWhisper } from "./speech";
import { generateKeywordsOpenRouter } from "./llm";
import { filterAndSortLast30Days, searchTikTokByKeywordViaApify } from "./apify";
import { formatHelp, formatResultMessage, type KeywordBlock } from "./format";

const config = loadConfig();
const bot = new Bot(config.telegramBotToken);

function isAllowedUser(fromId: number | undefined): boolean {
  if (!fromId) return false;
  return config.allowedTelegramUserIds.has(fromId);
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

    const { recent, unknownDate } = filterAndSortLast30Days(items);
    const topRecent = recent.slice(0, perKeywordTop);
    const topUnknown = unknownDate.slice(0, Math.max(0, perKeywordTop - topRecent.length));

    if (topRecent.length || topUnknown.length) anyVideos = true;

    blocks.push({
      keyword,
      videos: topRecent,
      unknownDateVideos: topUnknown,
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
  if (!isAllowedUser(ctx.from?.id)) return;
  await ctx.reply(formatHelp(bot.botInfo?.username), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
});

bot.command("find", async (ctx) => {
  if (!isAllowedUser(ctx.from?.id)) return;

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
          disable_web_page_preview: true,
        });
        return;
      }

      await ctx.api.editMessageText(ctx.chat.id, status.message_id, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
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
  if (!isAllowedUser(ctx.from?.id)) return;

  await withChatLock(ctx.chat.id, async () => {
    const replyTo = ctx.message?.message_id;
    const status = await ctx.reply("🎙️ Распознаю голос…", {
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });

    try {
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
        disable_web_page_preview: true,
      });

      const { text, hadAnyResults } = await runPipeline({
        chatId: ctx.chat.id,
        replyToMessageId: replyTo,
        queryText: transcript,
        originalQueryLabel: "STT",
      });

      if (!hadAnyResults) {
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Ничего не нашёл по этим ключам 😕", {
          disable_web_page_preview: true,
        });
        return;
      }

      await ctx.api.editMessageText(ctx.chat.id, status.message_id, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
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

console.log("Bot starting…");
bot.start({ drop_pending_updates: true });

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

