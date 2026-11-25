import { collectAnimeSearchTitles, resolveTmdbIdentity, tmdbDiscoverFeed } from "./tmdb.ts";
export { collectAnimeSearchTitles };
import { dedupeStrings, asciiFold } from "./text.ts";
import { fetchJson, fetchText, postJson } from "./http.ts";
import type { ResolvedTmdbIdentity } from "./tmdb.ts";
import type { MediaSummary, StreamCandidate } from "vessel";
import { extractAnizmPlayer } from "../extractors/video-hosts.ts";
import { extractOkRu } from "../extractors/okru.ts";
import { extractSibnet } from "../extractors/sibnet.ts";

export interface AnimeTrackerInfo {
  tmdbId?: string;
  tvdbId?: string;
  isMovie: boolean | null;
  titles: string[];
  mappedSeason?: number;
  mappedEpisode?: number;
  absoluteEpisode?: number;
}

interface AniZipResponse {
  mappings?: {
    themoviedb_id?: number | string;
    thetvdb_id?: number | string;
    type?: string;
  };
  titles?: Record<string, string>;
  episodes?: Record<
    string,
    {
      seasonNumber?: number;
      episodeNumber?: number;
      absoluteEpisodeNumber?: number;
    }
  >;
}

interface KitsuResponse {
  data?: {
    attributes?: {
      canonicalTitle?: string;
      titles?: Record<string, string>;
      abbreviatedTitles?: string[];
      subtype?: string;
    };
  };
  included?: Array<{
    attributes?: {
      externalSite?: string;
      externalId?: string;
    };
  }>;
}

interface AniListResponse {
  data?: {
    Media?: {
      format?: string;
      title?: {
        english?: string;
        romaji?: string;
        native?: string;
      };
      synonyms?: string[];
    };
  };
}

/**
 * Resolves AniZip / Kitsu / AniList external anime tracker IDs into
 * canonical titles, TMDB/TVDB links, and mapped episode numbers.
 */
export async function resolveAnimeTrackerInfo(
  kind: "kitsu" | "mal" | "anilist" | "anidb",
  extId: string,
  episode = 1,
): Promise<AnimeTrackerInfo> {
  const result: AnimeTrackerInfo = {
    isMovie: null,
    titles: [],
  };
  if (!extId) return result;

  const rawTitles: string[] = [];
  const paramKey =
    kind === "kitsu"
      ? "kitsu_id"
      : kind === "mal"
        ? "mal_id"
        : kind === "anilist"
          ? "anilist_id"
          : "anidb_id";

  const aniZip = await fetchJson<AniZipResponse>(
    `https://api.ani.zip/mappings?${paramKey}=${encodeURIComponent(extId)}`,
    { timeoutMs: 5_000 },
  );
  if (aniZip?.mappings) {
    const m = aniZip.mappings;
    if (m.themoviedb_id) result.tmdbId = String(m.themoviedb_id);
    if (m.thetvdb_id) result.tvdbId = String(m.thetvdb_id);
    if (m.type === "MOVIE") result.isMovie = true;
    else if (m.type === "TV" || m.type === "OVA" || m.type === "ONA") {
      result.isMovie = false;
    }
    if (aniZip.titles) {
      if (aniZip.titles.en) rawTitles.push(aniZip.titles.en);
      if (aniZip.titles["x-jat"]) rawTitles.push(aniZip.titles["x-jat"]);
      if (aniZip.titles.ja) rawTitles.push(aniZip.titles.ja);
    }
    const epInfo = aniZip.episodes?.[String(episode)];
    if (epInfo) {
      if (epInfo.seasonNumber && epInfo.seasonNumber > 0) {
        result.mappedSeason = epInfo.seasonNumber;
      }
      if (epInfo.episodeNumber && epInfo.episodeNumber > 0) {
        result.mappedEpisode = epInfo.episodeNumber;
      }
      if (epInfo.absoluteEpisodeNumber && epInfo.absoluteEpisodeNumber > 0) {
        result.absoluteEpisode = epInfo.absoluteEpisodeNumber;
      }
    }
  }

  if ((!result.tmdbId && rawTitles.length === 0) || (kind === "kitsu" && rawTitles.length === 0)) {
    if (kind === "kitsu") {
      const kData = await fetchJson<KitsuResponse>(
        `https://kitsu.io/api/edge/anime/${encodeURIComponent(extId)}?include=mappings`,
        { timeoutMs: 5_000 },
      );
      const attr = kData?.data?.attributes;
      if (attr) {
        if (attr.canonicalTitle) rawTitles.push(attr.canonicalTitle);
        if (attr.titles?.en) rawTitles.push(attr.titles.en);
        if (attr.titles?.en_jp) rawTitles.push(attr.titles.en_jp);
        if (attr.titles?.ja_jp) rawTitles.push(attr.titles.ja_jp);
        for (const abbr of attr.abbreviatedTitles ?? []) {
          rawTitles.push(abbr);
        }
        if (result.isMovie === null && attr.subtype) {
          result.isMovie = attr.subtype.toLowerCase() === "movie";
        }
      }
      for (const inc of kData?.included ?? []) {
        const site = inc.attributes?.externalSite;
        const val = inc.attributes?.externalId;
        if (!result.tvdbId && val && (site === "thetvdb/series" || site === "thetvdb")) {
          result.tvdbId = val.split("/")[0];
        }
      }
    } else if (kind === "anilist" || kind === "mal") {
      const numericExt = Number.parseInt(extId, 10);
      if (!Number.isNaN(numericExt)) {
        const gqlVar = kind === "mal" ? { idMal: numericExt } : { id: numericExt };
        const gqlQuery =
          kind === "mal"
            ? "query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { format title { english romaji native } synonyms } }"
            : "query ($id: Int) { Media(id: $id, type: ANIME) { format title { english romaji native } synonyms } }";
        const al = await postJson<AniListResponse>(
          "https://graphql.anilist.co",
          { query: gqlQuery, variables: gqlVar },
          { timeoutMs: 5_000 },
        );
        const media = al?.data?.Media;
        if (media) {
          if (media.title?.english) rawTitles.push(media.title.english);
          if (media.title?.romaji) rawTitles.push(media.title.romaji);
          if (media.title?.native) rawTitles.push(media.title.native);
          for (const syn of (media.synonyms ?? []).slice(0, 4)) {
            rawTitles.push(syn);
          }
          if (result.isMovie === null && media.format) {
            result.isMovie = media.format === "MOVIE";
          }
        }
      }
    }
  }

  result.titles = dedupeStrings(rawTitles);
  return result;
}

// collectAnimeSearchTitles is defined in ./tmdb.ts and re-exported above.

/**
 * Queries DiziWatch anime mirrors + AnizmPlayer / OK.ru / Sibnet as a fast
 * fallback when origin anime sites time out or serve Cloudflare challenges.
 */
export async function resolveDiziWatchAnimeFallback(
  titles: string[],
  season: number,
  episode: number,
  sourceLabel: string,
): Promise<StreamCandidate[]> {
  const cleanTitles = dedupeStrings(titles).filter((t) => t.length >= 2);
  let slug = "";
  const probeQueries: string[] = [...cleanTitles.slice(0, 4)];
  for (const t of cleanTitles.slice(0, 2)) {
    const words = t.split(/\s+/).filter((w) => w.length >= 3);
    if (words.length >= 2) {
      probeQueries.push(`${words[0]}-${words[1]}`);
      probeQueries.push(words[0]!);
    }
  }

  for (const q of dedupeStrings(probeQueries)) {
    const arr = await fetchJson<Array<{ slug?: string; title?: string; name?: string }>>(
      `https://diziwatch.org/api/ara?q=${encodeURIComponent(q)}`,
      {
        timeoutMs: 4_000,
        headers: { Referer: "https://diziwatch.org/", Accept: "application/json" },
      },
    );
    if (!arr || arr.length === 0) continue;
    let bestSlug = "";
    let bestScore = 0;
    for (const item of arr) {
      if (!item.slug) continue;
      const itemName = item.title || item.name || item.slug.replace(/-/g, " ");
      for (const target of cleanTitles) {
        const sc = cleanAnimeTokenCompare(itemName, target);
        if (sc > bestScore) {
          bestScore = sc;
          bestSlug = item.slug;
        }
      }
    }
    if (bestSlug && bestScore >= 0.6) {
      slug = bestSlug;
      break;
    }
  }
  if (!slug) return [];

  const sN = season > 0 ? season : 1;
  const eN = episode > 0 ? episode : 1;
  const epUrl = `https://diziwatch.org/dizi/${slug}/sezon-${sN}/bolum-${eN}`;
  const htmlText = await fetchText(epUrl, {
    timeoutMs: 6_000,
    headers: { Referer: "https://diziwatch.org/" },
  });
  if (!htmlText) return [];

  const out: StreamCandidate[] = [];
  const hashSeen = new Set<string>();
  const anizmRe = /anizmplayer\.com\/video\/([a-f0-9]{24,40})/gi;
  let m: RegExpExecArray | null;
  while ((m = anizmRe.exec(htmlText)) !== null) {
    const hash = m[1];
    if (!hash || hashSeen.has(hash)) continue;
    hashSeen.add(hash);
    out.push(
      ...(await extractAnizmPlayer(hash, {
        sourceLabel,
        audioType: "sub",
        language: "ja",
        referer: "https://diziwatch.org/",
      })),
    );
    if (out.length >= 3) return out;
  }

  if (out.length === 0) {
    const okSeen = new Set<string>();
    for (const okMatch of htmlText.matchAll(/https?:\/\/ok\.ru\/videoembed\/\d+/gi)) {
      if (okSeen.has(okMatch[0])) continue;
      okSeen.add(okMatch[0]);
      out.push(
        ...(await extractOkRu(okMatch[0], {
          sourceLabel,
          audioType: "sub",
          language: "ja",
          referer: epUrl,
        })),
      );
      if (out.length >= 3) break;
    }
    const sibSeen = new Set<string>();
    for (const sibMatch of htmlText.matchAll(/https?:\/\/video\.sibnet\.ru\/shell\.php\?videoid=\d+/gi)) {
      if (sibSeen.has(sibMatch[0])) continue;
      sibSeen.add(sibMatch[0]);
      out.push(
        ...(await extractSibnet(sibMatch[0], {
          sourceLabel,
          audioType: "sub",
          language: "ja",
          referer: epUrl,
        })),
      );
      if (out.length >= 3) break;
    }
  }
  return out;
}

export async function discoverPopularAnime(idPrefix: string, page = 1): Promise<MediaSummary[]> {
  return tmdbDiscoverFeed({
    idPrefix,
    mediaType: "series",
    isAnime: true,
    originCountry: "JP",
    withGenres: "16",
    sortBy: "popularity.desc",
    page,
  });
}

export function cleanAnimeTokenCompare(a: string, b: string): number {
  const ta = asciiFold(a)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const tb = asciiFold(b)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (ta.length === 0 || tb.length === 0) return 0;
  let hits = 0;
  for (const w of ta) {
    if (tb.includes(w)) hits++;
  }
  return hits / Math.max(ta.length, tb.length);
}

export async function resolveAnimeIdentityOrTitle(
  id: string,
  preferType: "movie" | "series" = "series",
): Promise<ResolvedTmdbIdentity | null> {
  return resolveTmdbIdentity(id, preferType);
}
