# TikTok creatives finder — Telegram bot (MVP)

MVP бота для **группового чата**: текст/голос → распознавание речи → генерация 5 ключевиков → поиск TikTok через Apify → ссылки в чат.

## Требования

- Node.js 18+ (лучше 20+)
- Telegram bot token
- OpenRouter API key
- Apify API token
- OpenAI API key (для Whisper STT)

## Установка и запуск локально

```bash
cd "/Users/yuraokhapkin/Desktop/CreoHelper"
npm i
cp .env.example .env
npm run dev
```

## Куда вставить ключи

Заполни `.env`:

- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_TELEGRAM_USER_IDS` (например `123,456`)
- `OPENAI_API_KEY` (Whisper)
- `OPENROUTER_API_KEY`
- `APIFY_API_TOKEN`

Опционально:
- `OPENROUTER_MODEL`
- `APIFY_ACTOR_ID`, `APIFY_REGION`, `APIFY_MAX_RESULTS`

## Как протестировать в групповом чате

1) Добавь бота в группу.

2) **Критично для голосовых:** в BotFather отключи privacy mode (иначе бот в группе не будет получать голосовые, фото и обычный текст).
- BotFather → `/mybots` → выбери бота → **Bot Settings** → **Group Privacy** → **Turn off**

3) Выдай боту минимальные права **читать сообщения** (обычно достаточно).

4) В группе:
- Текстом: `/find подбери ключи для фоторедактора и найди топ за месяц`
- Голосом: просто отправь voice note (бот обработает всегда, но **только** от разрешённых пользователей).

## Команды

- `/help` — инструкция
- `/find <запрос>` — поиск по тексту

