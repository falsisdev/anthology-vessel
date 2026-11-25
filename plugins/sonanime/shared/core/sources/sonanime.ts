import type { StreamCandidate } from "vessel";
import { configString } from "../config.ts";
import { buildHeaders, fetchJson } from "../http.ts";
import { pickBestCandidate } from "../plugin-helpers.ts";
import { createStream } from "../quality.ts";
import { collectAnimeSearchTitles } from "../tmdb.ts";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";

export interface SonAnimeEpisode {
  anime_season?: number | string;
  episode_number?: number | string;
  upload_date?: string;
  episode_link_1080?: string;
  episode_link_720?: string;
  episode_link_480?: string;
  episode_link_360?: string;
}

export interface SonAnimeDetail {
  anime_link?: string;
  anime_name?: string;
  anime_name_en?: string;
  anime_type?: string;
  anime_photo?: string;
  anime_description?: string;
  anime_genres?: string[] | string;
  tmdb_id?: number | string;
  episodes?: SonAnimeEpisode[];
}

export function mapSonAnimeEpisodeStreams(
  ep: SonAnimeEpisode,
  base: string,
): StreamCandidate[] {
  const out: StreamCandidate[] = [];
  const entries: Array<[string | undefined, string]> = [
    [ep.episode_link_1080, "1080p"],
    [ep.episode_link_720, "720p"],
    [ep.episode_link_480, "480p"],
    [ep.episode_link_360, "360p"],
  ];
  for (const [url, q] of entries) {
    if (!url?.trim()) continue;
    out.push(
      createStream({
        url: url.trim(),
        kind: "mp4",
        quality: q,
        label: `SonAnime • Türkçe Altyazılı [${q}]`,
        audioType: "sub",
        language: "ja",
        headers: { Referer: `${base}/` },
      }),
    );
  }
  return out;
}

export async function resolveSonAnimeSlug(opts: {
  slug: string;
  apiBase: string;
  base: string;
  isMovie: boolean;
  season: number;
  episode: number;
}): Promise<StreamCandidate[]> {
  const detail = await fetchJson<SonAnimeDetail>(
    `${opts.apiBase}/api/anime/link/${encodeURIComponent(opts.slug)}`,
    { timeoutMs: 8_000, headers: buildHeaders(`${opts.base}/`) },
  );
  const eps = detail?.episodes ?? [];
  if (eps.length === 0) return [];

  const targetEp = opts.isMovie
    ? eps[0]
    : eps.find(
        (e) =>
          (Number(e.anime_season) || 1) === opts.season &&
          (Number(e.episode_number) || 1) === opts.episode,
      ) ?? eps.find((e) => (Number(e.episode_number) || 1) === opts.episode);

  return targetEp ? mapSonAnimeEpisodeStreams(targetEp, opts.base) : [];
}

export async function resolveSonAnimeByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season: number;
  episode: number;
  apiBase?: string;
  base?: string;
  exactTmdbOnly?: boolean;
}): Promise<StreamCandidate[]> {
  const apiBase = (
    opts.apiBase ??
    (await configString("urls.anime.sonanime.api_base", "https://api.sonanime.com"))
  ).replace(/\/+$/, "");
  const base = (
    opts.base ?? (await configString("urls.anime.sonanime.base", "https://sonanime.com"))
  ).replace(/\/+$/, "");

  const tmdbKey = String(opts.identity.tmdbId);
  let slug = "";
  const allCands: Array<SonAnimeDetail & { title: string }> = [];

  for (const q of collectAnimeSearchTitles(opts.identity).slice(0, 4)) {
    const hits = await fetchJson<SonAnimeDetail[]>(
      `${apiBase}/api/anime/search?q=${encodeURIComponent(q)}`,
      { timeoutMs: 7_000, headers: buildHeaders(`${base}/`) },
    );
    for (const h of hits ?? []) {
      if (!h.anime_link) continue;
      if (h.tmdb_id !== undefined && String(h.tmdb_id) === tmdbKey) {
        slug = h.anime_link;
        break;
      }
      if (!opts.exactTmdbOnly) {
        allCands.push({ ...h, title: h.anime_name || h.anime_name_en || "" });
      }
    }
    if (slug) break;
  }

  if (!slug && !opts.exactTmdbOnly && allCands.length > 0) {
    const best = pickBestCandidate(
      allCands,
      opts.identity.title,
      opts.identity.originalTitle,
    );
    if (best?.anime_link) slug = best.anime_link;
  }

  if (!slug) return [];
  return resolveSonAnimeSlug({
    slug,
    apiBase,
    base,
    isMovie: opts.identity.mediaType === "movie",
    season: opts.season,
    episode: opts.episode,
  });
}
