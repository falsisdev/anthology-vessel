import type { StreamCandidate } from "vessel";
import { configString } from "../config.ts";
import { buildHeaders, fetchJson, safeRequest } from "../http.ts";
import { dedupeStrings, titleSimilarity, ultraClean } from "../text.ts";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";
import { extractTauVideo } from "../../extractors/tauvideo.ts";

export const ANIMECIX_XEH_KEY =
  "7Y2ozlO+QysR5w9Q6Tupmtvl9jJp7ThFH8SB+Lo7NvZjgjqRSqOgcT2v4ISM9sP10LmnlYI8WQ==.xrlyOBFS5BHjQ2Lk";

export function animecixApiHeaders(base: string): Record<string, string> {
  return buildHeaders(`${base}/`, { "x-e-h": ANIMECIX_XEH_KEY });
}

export interface AnimecixTitleItem {
  id: number;
  name?: string;
  name_english?: string;
  poster?: string;
  backdrop?: string;
  description?: string;
  type?: string;
  is_series?: boolean;
  tmdb_id?: number | string;
  year?: number;
  episode_count?: number;
  seasons?: Array<{ number?: number; episode_count?: number }>;
}

interface AnimecixSearchResponse {
  results?: AnimecixTitleItem[];
}

export async function resolveAnimecixBestVideo(
  base: string,
  titleId: string,
  season: number,
  episode: number,
): Promise<StreamCandidate[]> {
  const res = await safeRequest(
    `${base}/secure/best-video?titleId=${encodeURIComponent(titleId)}&episode=${episode}&season=${season}`,
    {
      timeoutMs: 10_000,
      headers: animecixApiHeaders(base),
    },
  );
  if (!res) return [];
  for (const cand of [res.url, res.text()].filter(Boolean)) {
    const m =
      /(https?:\/\/(?:[a-z0-9-]+\.)?tau-video\.xyz\/embed\/[a-zA-Z0-9_-]+)/i.exec(
        cand,
      );
    if (m?.[1]) {
      return extractTauVideo(m[1], {
        sourceLabel: "AnimeciX",
        audioType: "sub",
        language: "ja",
        referer: `${base}/`,
      });
    }
  }
  return [];
}

export async function resolveAnimecixByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season: number;
  episode: number;
  base?: string;
  exactTmdbOnly?: boolean;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  const base = (
    opts.base ??
    (await configString("urls.anime.animecix.base", "https://animecix.tv"))
  ).replace(/\/+$/, "");

  const queries = dedupeStrings([
    identity.title,
    identity.originalTitle,
    ...identity.searchTitles.slice(0, 2),
  ]).slice(0, 3);

  for (const q of queries) {
    const res = await fetchJson<AnimecixSearchResponse>(
      `${base}/secure/search/${encodeURIComponent(q)}?limit=12`,
      { timeoutMs: 8_000, headers: animecixApiHeaders(base) },
    );
    const list = res?.results ?? [];
    const exactTmdb = list.find(
      (item) =>
        item.tmdb_id !== undefined &&
        item.tmdb_id !== null &&
        String(item.tmdb_id) === String(identity.tmdbId),
    );
    const matched =
      exactTmdb ??
      (opts.exactTmdbOnly
        ? undefined
        : list.find((item) => {
            const c = ultraClean(item.name || item.name_english || "");
            const qc = ultraClean(q);
            return Boolean(
              c &&
                qc &&
                (c.includes(qc) || qc.includes(c) || titleSimilarity(c, qc) >= 0.65),
            );
          }));
    if (matched) {
      const isMovie = matched.type === "movie" || matched.is_series === false;
      const streams = await resolveAnimecixBestVideo(
        base,
        String(matched.id),
        isMovie ? 1 : opts.season,
        isMovie ? 1 : opts.episode,
      );
      if (streams.length > 0) return streams;
    }
  }

  return [];
}
