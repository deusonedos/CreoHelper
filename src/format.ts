import { escapeHtml, compactNumber } from "./utils";
import type { TikTokVideo } from "./apify";

export type KeywordBlock = {
  keyword: string;
  videos: TikTokVideo[];
  unknownDateVideos?: TikTokVideo[];
};

function formatVideoLine(v: TikTokVideo): string {
  const views = compactNumber(v.views);
  const likes = v.likes != null ? compactNumber(v.likes) : null;
  const stats = likes ? `${views} 👀 / ${likes} ❤️` : `${views} 👀`;
  const url = escapeHtml(v.url);
  return `- ${stats} — <a href="${url}">link</a>`;
}

export function formatHelp(botUsername?: string): string {
  const mention = botUsername ? `@${botUsername}` : "бота";
  return [
    "<b>TikTok Creative Finder (MVP)</b>",
    "",
    "<b>Как пользоваться</b>",
    "- Текст: пиши как в ChatGPT — бот держит контекст диалога",
    "- Ключи: попроси <i>«подбери ключевые слова…»</i> или используй <code>/find …</code>",
    "- Поиск: после ключей нажми <b>🔎 Искать</b> или напиши <code>ищи</code>",
    "- Голос: скоро (пока отключено)",
    "",
    "<b>Пример</b>",
    "<code>Подбери 5 ключевых слов для приложения фоторедактора и найди TikTok видео за последний месяц с самым большим количеством просмотров</code>",
    "",
    "<b>Подсказка</b>",
    `- Чтобы бот видел обычный текст в группе — отключи privacy mode у ${mention} в BotFather.`,
  ].join("\n");
}

export function formatResultMessage(opts: {
  originalQuery: string;
  keywords: string[];
  keywordsLanguage?: string;
  blocks: KeywordBlock[];
  totalLimit: number;
}): string {
  const lines: string[] = [];

  lines.push("<b>Запрос</b>");
  lines.push(escapeHtml(opts.originalQuery));
  lines.push("");

  const lang = (opts.keywordsLanguage ?? "").toUpperCase();
  lines.push(`<b>Ключевые слова${lang ? ` (${escapeHtml(lang)})` : ""}</b>`);
  lines.push(opts.keywords.map((k, i) => `${i + 1}) ${escapeHtml(k)}`).join("\n"));
  lines.push("");

  lines.push("<b>Результаты (сортировка по просмотрам)</b>");

  let totalAdded = 0;
  for (const block of opts.blocks) {
    if (totalAdded >= opts.totalLimit) break;

    lines.push("");
    lines.push(`<b>${escapeHtml(block.keyword)}</b>`);

    const recent = block.videos ?? [];
    const unknown = block.unknownDateVideos ?? [];
    if (!recent.length && !unknown.length) {
      lines.push("- (ничего не нашёл)");
      continue;
    }

    for (const v of recent) {
      if (totalAdded >= opts.totalLimit) break;
      lines.push(formatVideoLine(v));
      totalAdded++;
    }

    if (unknown.length && totalAdded < opts.totalLimit) {
      lines.push("<i>Без даты:</i>");
      for (const v of unknown.slice(0, Math.max(0, opts.totalLimit - totalAdded))) {
        lines.push(formatVideoLine(v));
        totalAdded++;
      }
    }
  }

  // Telegram hard limit ~4096 chars. Keep a safety buffer.
  let text = lines.join("\n");
  const maxLen = 3900;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen - 20).trimEnd() + "\n\n<i>…обрезано…</i>";
  }
  return text;
}

