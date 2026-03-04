# TikTok creatives finder — Telegram bot (MVP)

MVP бота для **группового чата**: текст/голос → распознавание речи → генерация 5 ключевиков → поиск TikTok через Apify → ссылки в чат.

## Требования

- Node.js 18+ (лучше 20+)
- Telegram bot token
- OpenRouter API key
- Apify API token
- (опционально позже) Любой OpenAI-compatible STT key (Whisper), например Groq

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
- `OPENROUTER_API_KEY`
- `APIFY_API_TOKEN`

Опционально:
- `OPENROUTER_MODEL`
- `APIFY_ACTOR_ID`, `APIFY_REGION`, `APIFY_MAX_RESULTS`
- `STT_API_KEY`, `STT_ENDPOINT`, `STT_MODEL` (для голосовых, позже)

### Дешёвый STT без OpenAI (пример Groq)

Groq поддерживает OpenAI-compatible endpoint для транскрибации:

- `STT_ENDPOINT=https://api.groq.com/openai/v1/audio/transcriptions`
- `STT_API_KEY=<GROQ_API_KEY>`
- `STT_MODEL=whisper-large-v3-turbo`

## Как протестировать в групповом чате

1) Добавь бота в группу.

2) **Критично для голосовых:** в BotFather отключи privacy mode (иначе бот в группе не будет получать голосовые, фото и обычный текст).
- BotFather → `/mybots` → выбери бота → **Bot Settings** → **Group Privacy** → **Turn off**

3) Выдай боту минимальные права **читать сообщения** (обычно достаточно).

4) В группе:
- Текстом: просто напиши запрос (или используй `/find ...`)
- Голосом: позже (пока отключено)

## Команды

- `/help` — инструкция
- `/find <запрос>` — поиск по тексту (опционально, можно писать и без команды)

