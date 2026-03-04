import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import http from "node:http";
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

  return await runApifyForKeywords({
    originalQuery: opts.originalQueryLabel ? `${opts.originalQueryLabel}\n${opts.queryText}` : opts.queryText,
    keywords: keywordsRes.keywords,
    keywordsLanguage: keywordsRes.language,
  });
}

async function runApifyForKeywords(opts: {
  originalQuery: string;
  keywords: string[];
  keywordsLanguage?: string;
}): Promise<{ text: string; hadAnyResults: boolean }> {
  const perKeywordTop = 5;
  const totalLimit = 30;

  const blocks: KeywordBlock[] = [];
  let anyVideos = false;

  for (const keyword of opts.keywords) {
    const items = await searchTikTokByKeywordViaApify({
      apiToken: config.apifyApiToken,
      actorId: config.apifyActorId,
      keyword,
      maxResults: config.apifyMaxResults,
    });
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        stage: "apify_result",
        keyword,
        items: items.length,
        sampleUrl: items[0]?.url ?? null,
        sampleViews: items[0]?.views ?? null,
      })
    );

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
    originalQuery: opts.originalQuery,
    keywords: opts.keywords,
    keywordsLanguage: opts.keywordsLanguage,
    blocks,
    totalLimit,
  });

  return { text, hadAnyResults: anyVideos };
}

type Pending = {
  query: string;
  answer: string;
  keywords: string[];
  language: string;
  createdAt: number;
};

const pendingByChat = new Map<number, Pending>();
const PENDING_TTL_MS = 30 * 60 * 1000;

function setPending(chatId: number, p: Pending) {
  pendingByChat.set(chatId, p);
}

function getPending(chatId: number): Pending | null {
  const p = pendingByChat.get(chatId);
  if (!p) return null;
  if (Date.now() - p.createdAt > PENDING_TTL_MS) {
    pendingByChat.delete(chatId);
    return null;
  }
  return p;
}

function pendingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔎 Искать", "do_search")
    .text("🔁 Перегенерить", "regen_keys")
    .row()
    .text("🧹 Сброс", "clear_pending");
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
    `- apify.maxResults: <code>${config.apifyMaxResults}</code>`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});

bot.callbackQuery(["do_search", "regen_keys", "clear_pending"], async (ctx) => {
  if (!isGroupChat((ctx.chat as any)?.type)) return;
  await ctx.answerCallbackQuery();

  const chatId = ctx.chat!.id;
  const action = ctx.callbackQuery.data;

  if (action === "clear_pending") {
    pendingByChat.delete(chatId);
    await ctx.reply("Ок, сбросил. Напиши новый запрос.", { link_preview_options: { is_disabled: true } });
    return;
  }

  const pending = getPending(chatId);
  if (!pending) {
    await ctx.reply("Не вижу сохранённых ключей. Напиши запрос ещё раз.", { link_preview_options: { is_disabled: true } });
    return;
  }

  if (action === "regen_keys") {
    const status = await ctx.reply("🔁 Перегенерирую ключевые слова…", { link_preview_options: { is_disabled: true } });
    try {
      const llm = await generateKeywordsOpenRouter({
        apiKey: config.openRouterApiKey,
        model: config.openRouterModel,
        query: pending.query,
      });
      const next: Pending = { ...pending, answer: llm.answer, keywords: llm.keywords, language: llm.language, createdAt: Date.now() };
      setPending(chatId, next);

      const msg = [
        `<b>Запрос</b>\n${pending.query}`,
        "",
        `<b>${llm.answer.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</b>`,
        "",
        `<b>Ключевые слова (${(llm.language ?? "en").toUpperCase()})</b>`,
        llm.keywords.map((k, i) => `${i + 1}) ${k}`).join("\n"),
        "",
        "Если ок — нажми <b>🔎 Искать</b> или напиши <code>ищи</code>.",
      ].join("\n");

      await ctx.api.editMessageText(chatId, status.message_id, msg, {
        parse_mode: "HTML",
        reply_markup: pendingKeyboard(),
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      console.error("regen_keys error:", e);
      await ctx.api.editMessageText(chatId, status.message_id, "Не смог перегенерировать ключи. Попробуй ещё раз.", {
        link_preview_options: { is_disabled: true },
      });
    }
    return;
  }

  // do_search
  await withChatLock(chatId, async () => {
    const status = await ctx.reply("⏳ Ищу TikTok креативы…", { link_preview_options: { is_disabled: true } });
    try {
      const { text, hadAnyResults } = await runApifyForKeywords({
        originalQuery: pending.query,
        keywords: pending.keywords,
        keywordsLanguage: pending.language,
      });
      if (!hadAnyResults) {
        await ctx.api.editMessageText(chatId, status.message_id, "Ничего не нашёл по этим ключам 😕", {
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      await ctx.api.editMessageText(chatId, status.message_id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      console.error("do_search error:", e);
      await ctx.api.editMessageText(chatId, status.message_id, userFacingErrorMessage(e), {
        link_preview_options: { is_disabled: true },
      });
    }
  });
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

  // Confirm search without hitting the scraper on every message.
  if (/^(ищи|search|go)\b/i.test(text)) {
    const pending = getPending(ctx.chat.id);
    if (!pending) {
      await ctx.reply("Не вижу сохранённых ключей. Напиши запрос, я предложу ключи, и потом скажи “ищи”.", {
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    await withChatLock(ctx.chat.id, async () => {
      const status = await ctx.reply("⏳ Ищу TikTok креативы…", { link_preview_options: { is_disabled: true } });
      try {
        const { text: out, hadAnyResults } = await runApifyForKeywords({
          originalQuery: pending.query,
          keywords: pending.keywords,
          keywordsLanguage: pending.language,
        });
        if (!hadAnyResults) {
          await ctx.api.editMessageText(ctx.chat.id, status.message_id, "Ничего не нашёл по этим ключам 😕", {
            link_preview_options: { is_disabled: true },
          });
          return;
        }
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, out, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        console.error("search confirm error:", e);
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, userFacingErrorMessage(e), {
          link_preview_options: { is_disabled: true },
        });
      }
    });
    return;
  }

  await withChatLock(ctx.chat.id, async () => {
    const replyTo = ctx.message?.message_id;
    const status = await ctx.reply("🤖 Думаю…", {
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });
    try {
      const llm = await generateKeywordsOpenRouter({
        apiKey: config.openRouterApiKey,
        model: config.openRouterModel,
        query: text,
      });

      setPending(ctx.chat.id, { query: text, answer: llm.answer, keywords: llm.keywords, language: llm.language, createdAt: Date.now() });

      const msg = [
        `<b>Запрос</b>\n${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`,
        "",
        `${llm.answer.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`,
        "",
        `<b>Ключевые слова (${(llm.language ?? "en").toUpperCase()})</b>`,
        llm.keywords.map((k, i) => `${i + 1}) ${k.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`).join("\n"),
        "",
        "Если ок — нажми <b>🔎 Искать</b> или напиши <code>ищи</code>.",
      ].join("\n");

      await ctx.api.editMessageText(ctx.chat.id, status.message_id, msg, {
        parse_mode: "HTML",
        reply_markup: pendingKeyboard(),
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

  // Same behavior as plain text: propose keywords first, then wait for confirmation.
  await ctx.reply(query);
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
  // Railway "web" services expect an HTTP port to be open.
  // Start a tiny health server if PORT is provided to avoid restarts/healthcheck failures.
  const portRaw = process.env.PORT;
  if (portRaw) {
    const port = Number(portRaw);
    if (Number.isFinite(port) && port > 0) {
      const server = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("running");
      });
      server.listen(port, "0.0.0.0", () => {
        console.log(`Health server listening on :${port}`);
      });
    }
  }

  // Log webhook state & ensure it is disabled (we use long polling on Railway).
  try {
    const info = await bot.api.getWebhookInfo();
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        stage: "webhook_info",
        url: info.url,
        has_custom_certificate: info.has_custom_certificate,
        pending_update_count: info.pending_update_count,
        last_error_date: info.last_error_date ?? null,
        last_error_message: info.last_error_message ?? null,
        max_connections: info.max_connections ?? null,
      })
    );
  } catch (e) {
    console.warn("getWebhookInfo failed (ignored):", e);
  }

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.warn("deleteWebhook failed (ignored):", e);
  }

  console.log("Bot starting…");
  // On Railway a brief overlap during deploys can happen. Also 409 may appear if webhook is set.
  // Never crash the process on 409: keep retrying with backoff until it stabilizes.
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({ drop_pending_updates: true });
      return;
    } catch (e: any) {
      const code = e?.error_code ?? e?.payload?.error_code;
      const msg = String(e?.message ?? e ?? "");
      const is409 = code === 409 || msg.includes("409") || msg.toLowerCase().includes("getupdates");
      if (is409) {
        // Ensure any partial polling loop is stopped before retrying.
        try {
          await bot.stop();
        } catch {
          // ignore
        }

        const waitMs = Math.min(30_000, 1000 * Math.min(attempt, 10));
        console.warn(`Long polling conflict (409). Retrying in ${waitMs}ms…`);
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
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

