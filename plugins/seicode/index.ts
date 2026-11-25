import { definePlugin } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
} from "vessel";
import { configString, resolveBaseUrl } from "./shared/core/config.ts";
import {
  SEICODE_TMDB_MAP,
  resolveSeicodeByIdentity,
  resolveSeicodeSlug,
} from "./shared/core/sources/seicode.ts";
import type { SeicodeAnimeItem } from "./shared/core/sources/seicode.ts";
import { buildHeaders, fetchJson, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import { finalizeStreams } from "./shared/core/plugin-helpers.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://seicode.net";
const DEFAULT_API = "https://next.seicode.net";

function mapSummary(a: SeicodeAnimeItem): MediaSummary | null {
  if (!a.slug) return null;
  return {
    nativeId: `anime:${a.slug}`,
    type: "series",
    isAnime: true,
    title: a.english || a.slug,
    poster: a.pictures?.avatar || a.pictures?.banner || undefined,
  };
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const apiBase = await resolveBaseUrl("urls.anime.seicode.api_base", DEFAULT_API, "mirrorUrl");
      const base = await configString("urls.anime.seicode.base", DEFAULT_BASE);
      const data = await fetchJson<{ animes?: SeicodeAnimeItem[] }>(`${apiBase}/anime?page=1`, {
        timeoutMs: 8_000,
        headers: buildHeaders(`${base}/`),
      });
      const items = (data?.animes ?? [])
        .map(mapSummary)
        .filter((x): x is MediaSummary => x !== null);
      return {
        sections:
          items.length > 0
            ? [{ id: "anime", title: "Popüler Animeler", layout: "poster", items }]
            : [],
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(query, _filters, page): Promise<SearchPage> {
    try {
      if (page > 1 || !query.trim()) return { items: [], hasMore: false };
      const apiBase = await resolveBaseUrl("urls.anime.seicode.api_base", DEFAULT_API, "mirrorUrl");
      const base = await configString("urls.anime.seicode.base", DEFAULT_BASE);
      const list = await fetchJson<SeicodeAnimeItem[]>(
        `${apiBase}/anime/search?q=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 7_000, headers: buildHeaders(`${base}/`) },
      );
      return {
        items: (list ?? []).map(mapSummary).filter((x): x is MediaSummary => x !== null),
        hasMore: false,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const apiBase = await resolveBaseUrl("urls.anime.seicode.api_base", DEFAULT_API, "mirrorUrl");
    const base = await configString("urls.anime.seicode.base", DEFAULT_BASE);
    const rawSlug = nativeId.replace(/^anime:/, "");
    const slug = SEICODE_TMDB_MAP[rawSlug] ?? rawSlug;

    const data = await fetchJson<SeicodeAnimeItem>(
      `${apiBase}/anime/${encodeURIComponent(slug)}`,
      { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
    );
    if (!data) throw new Error(`SeiCode içeriği açılamadı: ${slug}`);

    const seasons: SeasonSummary[] = [];
    const episodes: Episode[] = [];
    for (const s of data.seasons ?? []) {
      const sNum = Number(s.season_number) || 1;
      const eps = s.episodes ?? [];
      seasons.push({
        id: String(sNum),
        season: sNum,
        title: `${sNum}. Sezon`,
        episodeCount: eps.length,
      });
      for (let i = 0; i < eps.length; i++) {
        const epNum = Number(eps[i]?.episode_number) || i + 1;
        episodes.push({
          streamId: `ep:${slug}:${sNum}:${epNum}`,
          season: sNum,
          episode: epNum,
          title: `S${sNum} B${epNum}`,
        });
      }
    }

    return {
      nativeId,
      type: "series",
      isAnime: true,
      title: data.english || slug,
      poster: data.pictures?.avatar || undefined,
      backdrop: data.pictures?.banner || data.pictures?.avatar || undefined,
      synopsis: data.summary || undefined,
      genres: data.genres?.length ? data.genres : ["Anime"],
      externalIds: data.tmdbID ? { tmdb: Number(data.tmdbID) || undefined } : undefined,
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const apiBase = await resolveBaseUrl("urls.anime.seicode.api_base", DEFAULT_API, "mirrorUrl");
      const base = await configString("urls.anime.seicode.base", DEFAULT_BASE);

      if (streamId.startsWith("ep:") || streamId.startsWith("anime:")) {
        const parts = streamId.split(":");
        const slug = parts[1] ?? "";
        const sNum = Number.parseInt(parts[2] ?? "1", 10) || 1;
        const eNum = Number.parseInt(parts[3] ?? "1", 10) || 1;
        if (!slug) return { streams: [] };
        return finalizeStreams(
          await resolveSeicodeSlug({ slug, apiBase, base, season: sNum, episode: eNum }),
        );
      }

      const parts = streamId.split(":");
      const idToken = parts[0] ?? streamId;
      const sNum = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eNum = Number.parseInt(parts[2] ?? "1", 10) || 1;

      if (SEICODE_TMDB_MAP[idToken]) {
        return finalizeStreams(
          await resolveSeicodeSlug({
            slug: SEICODE_TMDB_MAP[idToken]!,
            apiBase,
            base,
            season: sNum,
            episode: eNum,
          }),
        );
      }

      const identity = await resolveTmdbIdentity(idToken, "series");
      if (!identity) return { streams: [] };

      return finalizeStreams(
        await resolveSeicodeByIdentity({
          identity,
          season: sNum,
          episode: eNum,
          apiBase,
          base,
          exactTmdbOnly: false,
        }),
      );
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
