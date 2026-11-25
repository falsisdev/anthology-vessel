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
  resolveSonAnimeByIdentity,
  resolveSonAnimeSlug,
} from "./shared/core/exact-tmdb-sources.ts";
import type { SonAnimeDetail } from "./shared/core/exact-tmdb-sources.ts";
import { buildHeaders, fetchJson, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import { finalizeStreams } from "./shared/core/plugin-helpers.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://sonanime.com";
const DEFAULT_API = "https://api.sonanime.com";

function mapSummary(a: SonAnimeDetail): MediaSummary | null {
  if (!a.anime_link) return null;
  const isMovie = a.anime_type === "movie";
  return {
    nativeId: `${isMovie ? "movie" : "anime"}:${a.anime_link}`,
    type: isMovie ? "movie" : "series",
    isAnime: true,
    title: a.anime_name || a.anime_name_en || a.anime_link,
    poster: a.anime_photo || undefined,
  };
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const apiBase = await resolveBaseUrl("urls.anime.sonanime.api_base", DEFAULT_API, "mirrorUrl");
      const base = await configString("urls.anime.sonanime.base", DEFAULT_BASE);
      const list = await fetchJson<SonAnimeDetail[]>(
        `${apiBase}/api/anime/browse?type=series&sortBy=rating&sortDir=desc`,
        { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
      );
      const items = (list ?? [])
        .slice(0, 48)
        .map(mapSummary)
        .filter((x): x is MediaSummary => x !== null);
      return {
        sections:
          items.length > 0
            ? [{ id: "popular", title: "En İyi Animeler", layout: "poster", items }]
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
      const apiBase = await resolveBaseUrl("urls.anime.sonanime.api_base", DEFAULT_API, "mirrorUrl");
      const base = await configString("urls.anime.sonanime.base", DEFAULT_BASE);
      const list = await fetchJson<SonAnimeDetail[]>(
        `${apiBase}/api/anime/search?q=${encodeURIComponent(query.trim())}`,
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
    const apiBase = await resolveBaseUrl("urls.anime.sonanime.api_base", DEFAULT_API, "mirrorUrl");
    const base = await configString("urls.anime.sonanime.base", DEFAULT_BASE);
    const slug = nativeId.replace(/^(?:anime|movie):/, "");
    const detail = await fetchJson<SonAnimeDetail>(
      `${apiBase}/api/anime/link/${encodeURIComponent(slug)}`,
      { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
    );
    if (!detail) throw new Error(`SonAnime içeriği bulunamadı: ${slug}`);

    const isMovie = detail.anime_type === "movie" || nativeId.startsWith("movie:");
    const title = detail.anime_name || detail.anime_name_en || slug;
    const rawEps = [...(detail.episodes ?? [])].sort(
      (a, b) =>
        (Number(a.anime_season) || 1) - (Number(b.anime_season) || 1) ||
        (Number(a.episode_number) || 1) - (Number(b.episode_number) || 1),
    );

    const episodes: Episode[] = isMovie
      ? [{ streamId: `ep:${slug}:1:1`, season: 1, episode: 1, title }]
      : rawEps.map((ep, idx) => {
          const s = Number(ep.anime_season) || 1;
          const e = Number(ep.episode_number) || idx + 1;
          return {
            streamId: `ep:${slug}:${s}:${e}`,
            season: s,
            episode: e,
            title: `${s}. Sezon ${e}. Bölüm`,
          };
        });

    const seasons: SeasonSummary[] = isMovie
      ? []
      : Array.from(new Set(episodes.map((x) => x.season))).map((s) => ({
          id: String(s),
          season: s,
          title: `${s}. Sezon`,
          episodeCount: episodes.filter((x) => x.season === s).length,
        }));

    let genres = ["Anime"];
    if (Array.isArray(detail.anime_genres) && detail.anime_genres.length > 0) {
      genres = detail.anime_genres;
    }

    return {
      nativeId,
      type: isMovie ? "movie" : "series",
      isAnime: true,
      title,
      originalTitle: detail.anime_name_en || undefined,
      poster: detail.anime_photo || undefined,
      backdrop: detail.anime_photo || undefined,
      synopsis: detail.anime_description || undefined,
      genres,
      externalIds: detail.tmdb_id ? { tmdb: Number(detail.tmdb_id) || undefined } : undefined,
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const apiBase = await resolveBaseUrl("urls.anime.sonanime.api_base", DEFAULT_API, "mirrorUrl");
      const base = await configString("urls.anime.sonanime.base", DEFAULT_BASE);

      if (streamId.startsWith("ep:") || streamId.startsWith("anime:") || streamId.startsWith("movie:")) {
        const parts = streamId.split(":");
        const slug = parts[1] ?? "";
        const isMovie = streamId.startsWith("movie:");
        const sNum = Number.parseInt(parts[2] ?? "1", 10) || 1;
        const eNum = Number.parseInt(parts[3] ?? "1", 10) || 1;
        if (!slug) return { streams: [] };
        return finalizeStreams(
          await resolveSonAnimeSlug({ slug, apiBase, base, isMovie, season: sNum, episode: eNum }),
        );
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const sNum = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eNum = Number.parseInt(parts[2] ?? "1", 10) || 1;

      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };

      return finalizeStreams(
        await resolveSonAnimeByIdentity({
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
