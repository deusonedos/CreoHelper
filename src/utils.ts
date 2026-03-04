export type Awaitable<T> = T | Promise<T>;

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function parseCsvNumberList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function compactNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\\.0$/, "")}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\\.0$/, "")}K`;
  return String(Math.trunc(n));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    // Consumers can optionally use controller.signal by capturing it outside.
    // Here we just abort to break fetches that honor AbortSignal.
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(`${label} timed out after ${ms}ms`)));
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// Very small per-chat mutex/queue to avoid overlapping runs in group chat.
const chatQueues = new Map<number, Promise<void>>();

export async function withChatLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();

  // Run after previous finishes (even if it failed).
  const resultPromise = prev.then(fn, fn);

  // Tail promise must never reject, so the queue continues.
  const tail = resultPromise.then(
    () => undefined,
    () => undefined
  );

  chatQueues.set(chatId, tail);

  try {
    return await resultPromise;
  } finally {
    if (chatQueues.get(chatId) === tail) chatQueues.delete(chatId);
  }
}

export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

