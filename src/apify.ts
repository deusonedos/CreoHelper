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

function unwrapActorItem(item: any): any {
  if (!item) return item;
  // Actor UI often shows `Aweme_info` / `aweme_info` wrapper. Unwrap it.
  if (item.aweme_info && typeof item.aweme_info === "object") return item.aweme_info;
  if (item.Aweme_info && typeof item.Aweme_info === "object") return item.Aweme_info;
  if (item.awemeInfo && typeof item.awemeInfo === "object") return item.awemeInfo;
  if (item.item && typeof item.item === "object") return item.item;
  // Sometimes actors return JSON string fields.
  if (typeof item === "string" && item.trim().startsWith("{")) {
    try {
      return JSON.parse(item);
    } catch {
      return item;
    }
  }
  return item;
}

function normalizeVideo(item: any): TikTokVideo | null {
  item = unwrapActorItem(item);

  const url =
    pickFirstString(item, ["url", "share_url", "webVideoUrl", "videoUrl", "shareUrl", "shareURL"]) ??
    pickFirstString(item?.share_info, ["share_url", "shareUrl"]) ??
    (typeof item?.aweme_id === "string"
      ? `https://www.tiktok.com/@tiktok/video/${item.aweme_id}`
      : typeof item?.id === "string"
        ? `https://www.tiktok.com/@tiktok/video/${item.id}`
        : null);
  if (!url) return null;

  const views =
    pickFirstNumber(item, ["views", "viewCount", "playCount"]) ??
    pickFirstNumber(item?.stats, ["views", "viewCount", "playCount"]) ??
    pickFirstNumber(item?.statistics, ["play_count", "view_count", "playCount", "viewCount"]) ??
    null;
  const likes =
    pickFirstNumber(item, ["likes", "likeCount", "diggCount"]) ??
    pickFirstNumber(item?.stats, ["likes", "likeCount", "diggCount"]) ??
    pickFirstNumber(item?.statistics, ["digg_count", "like_count", "diggCount", "likeCount"]) ??
    null;

  const createdAt =
    parseMaybeDate(item?.createdAt) ??
    parseMaybeDate(item?.publishedAt) ??
    parseMaybeDate(item?.createTimeISO) ??
    parseMaybeDate(item?.createTime) ??
    parseMaybeDate(item?.create_time_utc) ??
    parseMaybeDate(item?.create_time) ??
    null;

  const description = pickFirstString(item, ["description", "desc", "text"]) ?? null;

  const author =
    pickFirstString(item?.author, ["uniqueId", "nickname", "name"]) ??
    pickFirstString(item, ["author", "authorName", "authorUniqueId"]) ??
    pickFirstString(item?.author, ["unique_id"]) ??
    null;

  return { url, views, likes, createdAt, description, author };
}

export function splitAndSortByViews(videos: TikTokVideo[]): {
  withDate: TikTokVideo[];
  withoutDate: TikTokVideo[];
} {
  const withDate: TikTokVideo[] = [];
  const withoutDate: TikTokVideo[] = [];

  for (const v of videos) {
    if (v.createdAt) withDate.push(v);
    else withoutDate.push(v);
  }

  withDate.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  withoutDate.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));

  return { withDate, withoutDate };
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
  if (Array.isArray(items) && items.length > 0) {
    const first = unwrapActorItem(items[0]);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        stage: "apify_dataset_sample",
        keyword: opts.keyword,
        rawCount: items.length,
        firstKeys: first && typeof first === "object" ? Object.keys(first).slice(0, 25) : typeof first,
        firstUrl: pickFirstString(first, ["url", "share_url"]) ?? pickFirstString(first?.share_info, ["share_url"]) ?? null,
        firstViews:
          pickFirstNumber(first?.statistics, ["play_count", "view_count"]) ??
          pickFirstNumber(first, ["views", "viewCount", "playCount"]) ??
          null,
      })
    );
  }
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

