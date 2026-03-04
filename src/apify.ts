import { compactNumber } from "./utils";

export type TikTokVideo = {
  url: string;
  views: number | null;
  likes: number | null;
  createdAt: Date | null;
  description: string | null;
  author: string | null;
};

type ApifyRunResponse = {
  data?: {
    id?: string;
    status?: string;
    defaultDatasetId?: string;
  };
};

function parseMaybeDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;

  if (typeof value === "number" && Number.isFinite(value)) {
    // seconds or ms
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    const asNum = Number(s);
    if (Number.isFinite(asNum) && s.length >= 9) return parseMaybeDate(asNum);
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  return null;
}

function pickFirstString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickFirstNumber(obj: any, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function normalizeVideo(item: any): TikTokVideo | null {
  const url =
    pickFirstString(item, ["url", "webVideoUrl", "videoUrl", "shareUrl"]) ??
    (typeof item?.id === "string" ? `https://www.tiktok.com/@tiktok/video/${item.id}` : null);
  if (!url) return null;

  const views =
    pickFirstNumber(item, ["views", "viewCount", "playCount"]) ??
    pickFirstNumber(item?.stats, ["views", "viewCount", "playCount"]) ??
    null;
  const likes =
    pickFirstNumber(item, ["likes", "likeCount", "diggCount"]) ??
    pickFirstNumber(item?.stats, ["likes", "likeCount", "diggCount"]) ??
    null;

  const createdAt =
    parseMaybeDate(item?.createdAt) ??
    parseMaybeDate(item?.publishedAt) ??
    parseMaybeDate(item?.createTimeISO) ??
    parseMaybeDate(item?.createTime) ??
    null;

  const description = pickFirstString(item, ["description", "desc", "text"]) ?? null;

  const author =
    pickFirstString(item?.author, ["uniqueId", "nickname", "name"]) ??
    pickFirstString(item, ["author", "authorName", "authorUniqueId"]) ??
    null;

  return { url, views, likes, createdAt, description, author };
}

export function filterAndSortLast30Days(videos: TikTokVideo[]): {
  recent: TikTokVideo[];
  unknownDate: TikTokVideo[];
} {
  const threshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent: TikTokVideo[] = [];
  const unknownDate: TikTokVideo[] = [];

  for (const v of videos) {
    if (!v.createdAt) {
      unknownDate.push(v);
      continue;
    }
    if (v.createdAt.getTime() >= threshold) recent.push(v);
  }

  recent.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  unknownDate.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));

  return { recent, unknownDate };
}

export async function searchTikTokByKeywordViaApify(opts: {
  apiToken: string;
  actorId: string;
  keyword: string;
  region: string;
  maxResults: number;
}): Promise<TikTokVideo[]> {
  const input = {
    query: opts.keyword,
    date_posted: "this-month",
    sort_by: "views",
    region: opts.region,
    max_results: opts.maxResults,
    trim: false
  };

  const runUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(opts.actorId)}/runs?token=${encodeURIComponent(
    opts.apiToken
  )}&waitForFinish=120`;

  const runRes = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!runRes.ok) {
    const body = await runRes.text().catch(() => "");
    throw new Error(`Apify run error ${runRes.status}: ${body.slice(0, 500)}`);
  }

  const runData = (await runRes.json()) as ApifyRunResponse;
  const datasetId = runData.data?.defaultDatasetId;
  if (!datasetId) {
    throw new Error(`Apify did not return defaultDatasetId (status=${runData.data?.status ?? "unknown"})`);
  }

  const itemsUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(
    datasetId
  )}/items?token=${encodeURIComponent(opts.apiToken)}&clean=true&format=json&limit=${opts.maxResults}`;

  const itemsRes = await fetch(itemsUrl, { method: "GET" });
  if (!itemsRes.ok) {
    const body = await itemsRes.text().catch(() => "");
    throw new Error(`Apify dataset error ${itemsRes.status}: ${body.slice(0, 500)}`);
  }

  const items = (await itemsRes.json()) as any[];
  const videos: TikTokVideo[] = [];
  for (const item of items) {
    const v = normalizeVideo(item);
    if (v) videos.push(v);
  }

  // Basic dedupe by URL
  const seen = new Set<string>();
  const deduped: TikTokVideo[] = [];
  for (const v of videos) {
    if (seen.has(v.url)) continue;
    seen.add(v.url);
    deduped.push(v);
  }

  return deduped;
}

export function debugVideo(v: TikTokVideo): string {
  return `${compactNumber(v.views)} views | ${v.url}`;
}

