import type { StreamCandidate } from "vessel";
import { configString } from "../config.ts";
import { DEFAULT_USER_AGENT, fetchJson } from "../http.ts";
import { createStream, inferStreamKind } from "../quality.ts";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";
import { VIXOLITY_HEADERS } from "../../extractors/vixolity.ts";

interface GoVodStreamItem {
  title?: string;
  url?: string;
  quality?: string;
  format?: string;
  isHls?: boolean;
  score?: number;
  headers?: Record<string, string>;
}

interface GoVodResponse {
  streams?: GoVodStreamItem[];
}

export async function resolveGoVodByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season?: number;
  episode?: number;
  customBaseUrl?: string;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  const defaultApi = await configString(
    "urls.vod.anthology_live_api",
    "https://anthology-live.duckdns.org/api/vod/streams",
  );
  const apiBase = opts.customBaseUrl?.trim()
    ? `${opts.customBaseUrl.trim().replace(/\/+$/, "")}/api/vod/streams`
    : defaultApi;

  const qs = new URLSearchParams({
    type: identity.mediaType,
    imdb: identity.imdbId ?? "",
    title: identity.title,
    original_title: identity.originalTitle,
    year: identity.year ? String(identity.year) : "",
  });
  if (identity.mediaType === "series") {
    qs.set("season", String(opts.season ?? 1));
    qs.set("episode", String(opts.episode ?? 1));
  }

  const data = await fetchJson<GoVodResponse>(`${apiBase}?${qs.toString()}`, {
    timeoutMs: 8_000,
    headers: { "User-Agent": DEFAULT_USER_AGENT },
  });

  const streams: StreamCandidate[] = [];
  for (const item of data?.streams ?? []) {
    if (!item.url) continue;
    const isVix = /vixolity\.com/i.test(item.url);
    streams.push(
      createStream({
        url: item.url,
        kind: inferStreamKind(
          item.url,
          item.format ?? (item.isHls || isVix ? "hls" : undefined),
        ),
        quality: item.quality || "1080p",
        label: item.title || `Anthology VOD • ${item.quality || "HD"}`,
        priority: item.score,
        headers:
          item.headers ??
          (isVix ? VIXOLITY_HEADERS : { "User-Agent": DEFAULT_USER_AGENT }),
      }),
    );
  }
  return streams;
}
