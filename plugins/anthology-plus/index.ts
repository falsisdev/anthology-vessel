import { definePlugin, storage } from "vessel";
import type {
  Episode,
  HomeFeed,
  HomeSection,
  MediaDetail,
  SearchPage,
  StreamCandidate,
  StreamResult,
} from "vessel";
import { configString, readToggleSetting } from "./shared/core/config.ts";
import {
  SEICODE_TMDB_MAP,
  resolveAnimecixByIdentity,
  resolveGoVodByIdentity,
  resolveHdFilmDelisiByIdentity,
  resolveSeicodeByIdentity,
  resolveSinemaCxByIdentity,
  resolveSonAnimeByIdentity,
  resolveVidlinkByIdentity,
} from "./shared/core/exact-tmdb-sources.ts";
import { isDomainBlockedError, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import { finalizeStreams, getTmdbBackedMovieDetails } from "./shared/core/plugin-helpers.ts";
import {
  resolveTmdbIdentity,
  tmdbDiscoverFeed,
  tmdbGetSeasonEpisodes,
  tmdbSearch,
} from "./shared/core/tmdb.ts";
import { extractVixolity } from "./shared/extractors/vixolity.ts";

const ID_PREFIX = "anthology-plus";

function parsePlusStreamId(streamId: string): {
  typeHint: "movie" | "series";
  idToken: string;
  season: number;
  episode: number;
  explicitAnime: boolean;
} {
  const parts = streamId.split(":");
  const head = parts[0] ?? "";

  if (head === ID_PREFIX || head === "tmdb") {
    const second = parts[1] ?? "";
    if (second === "movie" || second === "series" || second === "anime") {
      return {
        explicitAnime: second === "anime",
        typeHint: second === "movie" ? "movie" : "series",
        idToken: parts[2] ?? streamId,
        season: Number.parseInt(parts[3] ?? "1", 10) || 1,
        episode: Number.parseInt(parts[4] ?? "1", 10) || 1,
      };
    }
    return {
      explicitAnime: false,
      typeHint: parts.length >= 3 ? "series" : "movie",
      idToken: parts[1] ?? streamId,
      season: Number.parseInt(parts[2] ?? "1", 10) || 1,
      episode: Number.parseInt(parts[3] ?? "1", 10) || 1,
    };
  }

  if (parts.length >= 3) {
    return {
      explicitAnime: false,
      typeHint: "series",
      idToken: head || streamId,
      season: Number.parseInt(parts[1] ?? "1", 10) || 1,
      episode: Number.parseInt(parts[2] ?? "1", 10) || 1,
    };
  }

  return {
    explicitAnime: false,
    typeHint: "movie",
    idToken: head || streamId,
    season: 1,
    episode: 1,
  };
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const [movies, series, anime] = await Promise.all([
        tmdbDiscoverFeed({
          idPrefix: ID_PREFIX,
          mediaType: "movie",
          sortBy: "popularity.desc",
        }),
        tmdbDiscoverFeed({
          idPrefix: ID_PREFIX,
          mediaType: "series",
          sortBy: "popularity.desc",
        }),
        tmdbDiscoverFeed({
          idPrefix: ID_PREFIX,
          mediaType: "series",
          isAnime: true,
          originCountry: "JP",
          withGenres: "16",
          sortBy: "popularity.desc",
        }),
      ]);

      const sections: HomeSection[] = [];
      if (movies.length > 0) {
        sections.push({
          id: "popular-movies",
          title: "Anthology+ • Popüler Filmler",
          layout: "poster",
          items: movies,
        });
      }
      if (series.length > 0) {
        sections.push({
          id: "popular-series",
          title: "Anthology+ • Popüler Diziler",
          layout: "poster",
          items: series,
        });
      }
      if (anime.length > 0) {
        sections.push({
          id: "popular-anime",
          title: "Anthology+ • Popüler Animeler",
          layout: "poster",
          items: anime,
        });
      }
      return { sections };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(query, filters, page): Promise<SearchPage> {
    try {
      const typeFilter = (filters["contentType"] ?? filters["type"] ?? "").toLowerCase();
      return await tmdbSearch({
        idPrefix: ID_PREFIX,
        query,
        mediaType:
          typeFilter === "movie"
            ? "movie"
            : typeFilter === "series" || typeFilter === "anime"
              ? "series"
              : "all",
        isAnime: typeFilter === "anime",
        page,
      });
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    return getTmdbBackedMovieDetails({
      nativeId,
      idPrefix: ID_PREFIX,
      mediaType: nativeId.includes(":series:") || nativeId.includes(":anime:") ? "series" : "movie",
    });
  },

  async getSeasonEpisodes(nativeId, seasonId): Promise<Episode[]> {
    const parts = nativeId.split(":");
    const tmdbId = Number.parseInt(parts[2] ?? nativeId, 10);
    const seasonNum = Number.parseInt(seasonId, 10) || 1;
    if (!Number.isFinite(tmdbId)) return [];
    return tmdbGetSeasonEpisodes(
      tmdbId,
      seasonNum,
      (s, ep) => `${ID_PREFIX}:series:${tmdbId}:${s}:${ep}`,
    );
  },

  async getStreams(streamId: string): Promise<StreamResult> {
    try {
      const parsed = parsePlusStreamId(streamId);
      const identity = await resolveTmdbIdentity(parsed.idToken, parsed.typeHint);
      if (!identity) return { streams: [] };

      const [
        useVixolity,
        useGoVod,
        useVidlink,
        useHdFilmDelisi,
        useSinemaCx,
        useAnimecix,
        useSeicode,
        useSonAnime,
        customLiveUrl,
        customVidlinkUrl,
      ] = await Promise.all([
        readToggleSetting("enableVixolity", true),
        readToggleSetting("enableGoVod", true),
        readToggleSetting("enableVidlink", true),
        readToggleSetting("enableHdFilmDelisi", true),
        readToggleSetting("enableSinemaCx", true),
        readToggleSetting("enableAnimecix", true),
        readToggleSetting("enableSeicode", true),
        readToggleSetting("enableSonAnime", true),
        storage.getSetting<string>("anthologyLiveUrl"),
        storage.getSetting<string>("vidlinkMirror"),
      ]);

      const isAnimeTarget =
        parsed.explicitAnime ||
        Boolean(identity.isAnime) ||
        Boolean(identity.isAnimation) ||
        Boolean(SEICODE_TMDB_MAP[String(identity.tmdbId)]);

      const tasks: Array<Promise<StreamCandidate[]>> = [];

      if (useVixolity && identity.imdbId) {
        const imdbId = identity.imdbId;
        tasks.push(
          configString("urls.vod.vixolity_base", "https://ha.vixolity.com").then(
            async (vixBase) =>
              (
                await extractVixolity({
                  imdbId,
                  season: identity.mediaType === "series" ? parsed.season : undefined,
                  episode: identity.mediaType === "series" ? parsed.episode : undefined,
                  baseUrl: vixBase,
                  sourceLabel: "Vixolity",
                })
              ).streams,
          ),
        );
      }

      if (useGoVod) {
        tasks.push(
          resolveGoVodByIdentity({
            identity,
            season: parsed.season,
            episode: parsed.episode,
            customBaseUrl: customLiveUrl ?? undefined,
          }),
        );
      }

      if (useVidlink) {
        tasks.push(
          resolveVidlinkByIdentity({
            identity,
            season: parsed.season,
            episode: parsed.episode,
            mirrorUrl: customVidlinkUrl ?? undefined,
          }),
        );
      }

      if (useHdFilmDelisi && identity.mediaType === "movie") {
        tasks.push(
          resolveHdFilmDelisiByIdentity({
            identity,
            exactImdbRequired: true,
            includeVixolity: false,
          }),
        );
      }

      if (useSinemaCx && identity.mediaType === "movie") {
        tasks.push(
          resolveSinemaCxByIdentity({
            identity,
            exactImdbIfPresent: true,
            includeVixolity: false,
          }),
        );
      }

      if (isAnimeTarget) {
        if (useAnimecix) {
          tasks.push(
            resolveAnimecixByIdentity({
              identity,
              season: parsed.season,
              episode: parsed.episode,
              exactTmdbOnly: true,
            }),
          );
        }
        if (useSeicode) {
          tasks.push(
            resolveSeicodeByIdentity({
              identity,
              season: parsed.season,
              episode: parsed.episode,
              exactTmdbOnly: true,
            }),
          );
        }
        if (useSonAnime) {
          tasks.push(
            resolveSonAnimeByIdentity({
              identity,
              season: parsed.season,
              episode: parsed.episode,
              exactTmdbOnly: true,
            }),
          );
        }
      }

      const settled = await Promise.allSettled(tasks);
      const collected: StreamCandidate[] = [];
      let blockedErr: unknown = null;

      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          collected.push(...outcome.value);
        } else if (isDomainBlockedError(outcome.reason)) {
          blockedErr = blockedErr ?? outcome.reason;
        }
      }

      if (blockedErr && collected.length === 0) {
        throw blockedErr;
      }

      return finalizeStreams(collected);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
