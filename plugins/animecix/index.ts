import { definePlugin } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  animecixApiHeaders,
  resolveAnimecixBestVideo,
  resolveAnimecixByIdentity,
} from "./shared/core/exact-tmdb-sources.ts";
import type { AnimecixTitleItem } from "./shared/core/exact-tmdb-sources.ts";
import { fetchJson, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import { finalizeStreams } from "./shared/core/plugin-helpers.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://animecix.tv";

interface AnimecixSearchResponse {
  results?: AnimecixTitleItem[];
}

interface AnimecixBrowseResponse {
  pagination?: {
    data?: AnimecixTitleItem[];
  };
}

interface AnimecixDetailResponse {
  title?: AnimecixTitleItem;
}

const apiHeaders = animecixApiHeaders;

function mapTitleSummary(item: AnimecixTitleItem): MediaSummary {
  const isMovie = item.type === "movie" || item.is_series === false;
  return {
    nativeId: `title:${item.id}:${isMovie ? "movie" : "series"}`,
    type: isMovie ? "movie" : "series",
    isAnime: true,
    title: item.name || item.name_english || "Anime",
    year: item.year,
    poster: item.poster || undefined,
  };
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.anime.animecix.base", DEFAULT_BASE, "mirrorUrl");
      const data = await fetchJson<AnimecixBrowseResponse>(
        `${base}/secure/titles?limit=24`,
        { timeoutMs: 10_000, headers: apiHeaders(base) },
      );
      const items = (data?.pagination?.data ?? []).map(mapTitleSummary);
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
      const base = await resolveBaseUrl("urls.anime.animecix.base", DEFAULT_BASE, "mirrorUrl");
      const data = await fetchJson<AnimecixSearchResponse>(
        `${base}/secure/search/${encodeURIComponent(query.trim())}?limit=20`,
        { timeoutMs: 8_000, headers: apiHeaders(base) },
      );
      return {
        items: (data?.results ?? []).map(mapTitleSummary),
        hasMore: false,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.anime.animecix.base", DEFAULT_BASE, "mirrorUrl");
    const titleId = nativeId.replace(/^title:/, "").split(":")[0] ?? nativeId;
    const data = await fetchJson<AnimecixDetailResponse>(
      `${base}/secure/titles/${encodeURIComponent(titleId)}`,
      { timeoutMs: 10_000, headers: apiHeaders(base) },
    );
    const t = data?.title;
    if (!t) throw new Error(`AnimeciX içeriği bulunamadı: ${titleId}`);

    const name = t.name || t.name_english || "Anime";
    const isMovie = t.type === "movie" || t.is_series === false;
    const seasons: SeasonSummary[] = [];
    const episodes: Episode[] = [];

    if (isMovie) {
      episodes.push({
        streamId: `ep:${titleId}:1:1`,
        season: 1,
        episode: 1,
        title: name,
      });
    } else if (t.seasons && t.seasons.length > 0) {
      for (const s of t.seasons) {
        const sNum = Number(s.number) || 1;
        const epCount = Number(s.episode_count) || 0;
        if (epCount <= 0) continue;
        seasons.push({
          id: String(sNum),
          season: sNum,
          title: `${sNum}. Sezon`,
          episodeCount: epCount,
        });
        for (let e = 1; e <= epCount; e++) {
          episodes.push({
            streamId: `ep:${titleId}:${sNum}:${e}`,
            season: sNum,
            episode: e,
            title: `${sNum}. Sezon ${e}. Bölüm`,
          });
        }
      }
    }

    if (!isMovie && episodes.length === 0) {
      const epCount = Math.max(1, Number(t.episode_count) || 1);
      seasons.push({ id: "1", season: 1, title: "1. Sezon", episodeCount: epCount });
      for (let e = 1; e <= epCount; e++) {
        episodes.push({
          streamId: `ep:${titleId}:1:${e}`,
          season: 1,
          episode: e,
          title: `${e}. Bölüm`,
        });
      }
    }

    return {
      nativeId,
      type: isMovie ? "movie" : "series",
      isAnime: true,
      title: name,
      originalTitle: t.name_english || undefined,
      year: t.year,
      poster: t.poster || undefined,
      backdrop: t.backdrop || t.poster || undefined,
      synopsis: t.description || undefined,
      genres: ["Anime"],
      externalIds: t.tmdb_id ? { tmdb: Number(t.tmdb_id) || undefined } : undefined,
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.anime.animecix.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("ep:") || streamId.startsWith("title:")) {
        const parts = streamId.split(":");
        const titleId = parts[1] ?? "";
        const s = streamId.startsWith("ep:") ? Number.parseInt(parts[2] ?? "1", 10) || 1 : 1;
        const e = streamId.startsWith("ep:") ? Number.parseInt(parts[3] ?? "1", 10) || 1 : 1;
        return finalizeStreams(await resolveAnimecixBestVideo(base, titleId, s, e));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };
      const sTarget = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      return finalizeStreams(
        await resolveAnimecixByIdentity({
          base,
          identity,
          season: sTarget,
          episode: eTarget,
          exactTmdbOnly: false,
        }),
      );
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
