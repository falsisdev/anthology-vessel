import { definePlugin, html } from "vessel";
import type {
  HomeFeed,
  MediaDetail,
  SearchPage,
  StreamCandidate,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  parseSinemacxCards,
  resolveSinemaCxByIdentity,
  resolveSinemaCxPage,
} from "./shared/core/sources/sinemacx.ts";
import {
  buildHeaders,
  fetchText,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import { finalizeStreams } from "./shared/core/plugin-helpers.ts";
import { decodeHtmlEntities, extractYear } from "./shared/core/text.ts";
import { resolveTmdbIdentity, tmdbDiscoverFeed } from "./shared/core/tmdb.ts";
import { extractVixolity } from "./shared/extractors/vixolity.ts";

const DEFAULT_BASE = "https://sinemacc.com";

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.sinemacx.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const htmlText = await fetchText(`${base}/`, {
        timeoutMs: 8_000,
        headers: buildHeaders(`${base}/`),
      });
      let items = htmlText ? parseSinemacxCards(htmlText, base) : [];
      if (items.length === 0) {
        items = await tmdbDiscoverFeed({
          idPrefix: "sinemacx",
          mediaType: "movie",
          sortBy: "popularity.desc",
        });
      }
      return {
        sections:
          items.length > 0
            ? [{ id: "featured", title: "Öne Çıkan Filmler", layout: "poster", items }]
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
      const base = await resolveBaseUrl(
        "urls.movies.sinemacx.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const htmlText = await fetchText(
        `${base}/?s=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
      );
      const items = htmlText ? parseSinemacxCards(htmlText, base) : [];
      return { items, hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    if (nativeId.startsWith("sinemacx:movie:")) {
      const identity = await resolveTmdbIdentity(
        nativeId.split(":")[2] ?? nativeId,
        "movie",
      );
      if (identity) {
        return {
          nativeId,
          type: "movie",
          title: identity.title,
          originalTitle: identity.originalTitle,
          year: identity.year,
          poster: identity.poster,
          backdrop: identity.backdrop,
          synopsis: identity.synopsis,
          genres: identity.genres,
          externalIds: identity.imdbId
            ? { tmdb: identity.tmdbId, imdb: identity.imdbId }
            : { tmdb: identity.tmdbId },
          episodes: [
            { streamId: nativeId, season: 1, episode: 1, title: identity.title },
          ],
        };
      }
    }

    const pageUrl = decodeURIComponent(nativeId.replace(/^movie:/, ""));
    const pageHtml = await fetchText(pageUrl, { headers: buildHeaders(pageUrl) });
    if (!pageHtml) throw new Error(`SinemaCX sayfası açılamadı: ${pageUrl}`);

    const doc = html.parse(pageHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() ||
        doc.selectOne("title")?.text().split("|")[0] ||
        "SinemaCX",
    ).trim();
    const poster =
      doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const imdbHref = doc.selectOne('a[href*="imdb.com/title/tt"]')?.attr("href");
    const imdbId = /tt\d+/.exec(imdbHref ?? "")?.[0];

    return {
      nativeId,
      type: "movie",
      title,
      year: extractYear(title),
      poster,
      backdrop: poster,
      externalIds: imdbId ? { imdb: imdbId } : undefined,
      episodes: [
        {
          streamId: imdbId ? `imdb:${imdbId}:${encodeURIComponent(pageUrl)}` : nativeId,
          season: 1,
          episode: 1,
          title,
        },
      ],
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.sinemacx.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const streams: StreamCandidate[] = [];

      if (streamId.startsWith("movie:")) {
        const pageUrl = decodeURIComponent(streamId.slice(6));
        streams.push(...(await resolveSinemaCxPage(pageUrl, base)));
        return finalizeStreams(streams);
      }

      if (streamId.startsWith("imdb:")) {
        const parts = streamId.split(":");
        const imdbId = parts[1] ?? "";
        const pageUrl = decodeURIComponent(parts.slice(2).join(":"));
        streams.push(...(await resolveSinemaCxPage(pageUrl, base)));
        if (streams.length === 0 && imdbId.startsWith("tt")) {
          const vix = await extractVixolity({ imdbId, sourceLabel: "SinemaCX" });
          streams.push(...vix.streams);
        }
        return finalizeStreams(streams);
      }

      const rawId = streamId.startsWith("sinemacx:movie:")
        ? streamId.split(":")[2]!
        : streamId.split(":")[0]!;
      const identity = await resolveTmdbIdentity(rawId, "movie");
      if (identity) {
        streams.push(
          ...(await resolveSinemaCxByIdentity({
            identity,
            base,
            includeVixolity: true,
          })),
        );
      }

      return finalizeStreams(streams);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
