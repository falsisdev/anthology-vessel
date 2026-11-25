import { definePlugin, html } from "vessel";
import type {
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  StreamCandidate,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  extractVidmodyEmbed,
  resolveHdFilmDelisiByIdentity,
} from "./shared/core/sources/hdfilmdelisi.ts";
import type {
  DelisiFilmRecord,
  DelisiListResponse,
} from "./shared/core/sources/hdfilmdelisi.ts";
import {
  buildHeaders,
  fetchJson,
  fetchText,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import { finalizeStreams } from "./shared/core/plugin-helpers.ts";
import { absoluteUrl, extractYear } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractVixolity } from "./shared/extractors/vixolity.ts";

const DEFAULT_BASE = "https://hdfilmdelisi.one";

function mapDelisiCard(f: DelisiFilmRecord, base: string): MediaSummary | null {
  const slug = String(f.slug ?? f.id ?? "").trim();
  const title = (f.baslik || f.title || "").trim();
  if (!slug || !title) return null;
  return {
    nativeId: `movie:${slug}`,
    type: "movie",
    title,
    year: extractYear(String(f.yayinYili ?? "")),
    poster: f.afis ? absoluteUrl(base, f.afis) : undefined,
  };
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.hdfilmdelisi.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const data = await fetchJson<DelisiListResponse>(
        `${base}/api/films?page=1&sort=newest&limit=28`,
        { timeoutMs: 12_000, headers: buildHeaders(`${base}/`) },
      );
      const items = (data?.results ?? data?.films ?? [])
        .map((f) => mapDelisiCard(f, base))
        .filter((x): x is MediaSummary => x !== null);
      return {
        sections:
          items.length > 0
            ? [{ id: "newest", title: "Yeni Eklenen Filmler", layout: "poster", items }]
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
        "urls.movies.hdfilmdelisi.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const data = await fetchJson<DelisiListResponse>(
        `${base}/api/search?q=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 12_000, headers: buildHeaders(`${base}/`) },
      );
      const items = (data?.results ?? data?.films ?? [])
        .map((f) => mapDelisiCard(f, base))
        .filter((x): x is MediaSummary => x !== null);
      return { items, hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl(
      "urls.movies.hdfilmdelisi.base",
      DEFAULT_BASE,
      "mirrorUrl",
    );
    const slug = nativeId.replace(/^movie:/, "");
    const pageUrl = `${base}/film/${slug}`;
    const [filmData, pageHtml] = await Promise.all([
      fetchJson<DelisiFilmRecord>(`${base}/api/films/${encodeURIComponent(slug)}`, {
        headers: buildHeaders(`${base}/`),
      }),
      fetchText(pageUrl, { headers: buildHeaders(`${base}/`) }),
    ]);

    const doc = pageHtml ? html.parse(pageHtml) : null;
    const title =
      filmData?.baslik ||
      doc?.selectOne("title")?.text().split("|")[0]?.split("-")[0]?.trim() ||
      slug;
    const poster =
      (filmData?.afis ? absoluteUrl(base, filmData.afis) : undefined) ??
      doc?.selectOne('meta[property="og:image"]')?.attr("content") ??
      undefined;

    return {
      nativeId: `movie:${slug}`,
      type: "movie",
      title,
      originalTitle: filmData?.orijinalBaslik,
      year: extractYear(String(filmData?.yayinYili ?? "")),
      poster,
      backdrop: poster,
      externalIds: filmData?.imdbId ? { imdb: filmData.imdbId } : undefined,
      episodes: [{ streamId: `movie:${slug}`, season: 1, episode: 1, title }],
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.hdfilmdelisi.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const vixBase = await resolveBaseUrl(
        "urls.movies.hdfilmdelisi.vidmody_player",
        "https://ha.vixolity.com",
      );
      const streams: StreamCandidate[] = [];

      if (streamId.startsWith("movie:") || !streamId.includes(":")) {
        const slug = streamId.replace(/^movie:/, "");
        const apiData = await fetchJson<DelisiFilmRecord>(
          `${base}/api/films/${encodeURIComponent(slug)}`,
          { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
        );
        if (apiData?.imdbId?.startsWith("tt")) {
          const vix = await extractVixolity({
            imdbId: apiData.imdbId,
            baseUrl: vixBase,
            sourceLabel: "HDFilmDelisi",
          });
          streams.push(...vix.streams);
        }
        streams.push(...(await extractVidmodyEmbed(`${base}/film/${slug}`, base)));
        if (streams.length > 0) return finalizeStreams(streams);
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (identity) {
        streams.push(
          ...(await resolveHdFilmDelisiByIdentity({
            identity,
            season: Number(parts[1] || 1),
            episode: Number(parts[2] || 1),
            base,
            vixBase,
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
