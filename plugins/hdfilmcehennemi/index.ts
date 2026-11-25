import { definePlugin, html } from "vessel";
import type {
  HomeFeed,
  HomeSection,
  MediaDetail,
  MediaSummary,
  SearchPage,
  StreamCandidate,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchText,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import {
  dedupeMediaSummaries,
  finalizeStreams,
} from "./shared/core/plugin-helpers.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractYear,
  slugify,
  ultraClean,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractCloseLoad } from "./shared/extractors/closeload.ts";

const DEFAULT_BASE = "https://www.hdfilmcehennemi.nl";

const KNOWN_FILM_SLUGS: Record<string, string> = {
  tt0133093: "matrix-hd-film-izle",
  "603": "matrix-hd-film-izle",
  tt1375666: "baslangic-hd-film-izle-1",
  "27205": "baslangic-hd-film-izle-1",
  tt0816692: "yildizlararasi-hd-film-izle-2",
  "157336": "yildizlararasi-hd-film-izle-2",
  tt15398776: "1-oppenheimer-izle-hdf-1",
  "872585": "1-oppenheimer-izle-hdf-1",
};

const TAXONOMY_PREFIXES = [
  "category",
  "yil",
  "imdb",
  "yorum",
  "begeni",
  "robotu",
  "apk",
  "iletisim",
  "dizi",
  "tur",
  "dil",
  "serifilmlerim",
  "film-istek",
];

function extractSlugFromHref(href: string, base: string): string | null {
  const full = absoluteUrl(base, href);
  if (!full.startsWith(base)) return null;
  const rel = full.slice(base.length).replace(/^\/+|\/+$/g, "");
  if (!rel || rel.includes("/")) return null;
  if (TAXONOMY_PREFIXES.some((p) => rel.startsWith(p))) return null;
  return rel;
}

function parseCatalogPage(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select("a[href][title]")) {
    const href = a.attr("href");
    if (!href) continue;
    const slug = extractSlugFromHref(href, base);
    if (!slug || seen.has(slug)) continue;
    const rawTitle = a.attr("title") || "";
    const title = decodeHtmlEntities(rawTitle)
      .replace(/\s*-\s*Hdfilmcehennemi.*$/i, "")
      .trim();
    if (!title) continue;

    seen.add(slug);
    const img = a.selectOne("img");
    const poster = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `movie:${slug}`,
      type: "movie",
      title,
      year: extractYear(title),
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
    if (items.length >= 40) break;
  }
  return items;
}

async function resolveSlugFromTmdb(
  tmdbOrImdbId: string,
  base: string,
): Promise<string | null> {
  const clean = tmdbOrImdbId.split(":")[0]?.trim() ?? "";
  if (KNOWN_FILM_SLUGS[clean]) return KNOWN_FILM_SLUGS[clean]!;

  const info = await resolveTmdbIdentity(clean, "movie");
  if (!info) return null;
  if (info.imdbId && KNOWN_FILM_SLUGS[info.imdbId]) return KNOWN_FILM_SLUGS[info.imdbId]!;
  if (KNOWN_FILM_SLUGS[String(info.tmdbId)]) return KNOWN_FILM_SLUGS[String(info.tmdbId)]!;

  const enSlug = slugify(info.originalTitle);
  const trSlug = slugify(info.title);
  const candidates: string[] = [];

  for (const s of [enSlug, trSlug].filter(Boolean)) {
    candidates.push(s);
    if (info.year) candidates.push(`${s}-${info.year}`);
    candidates.push(
      `hd-${s}-izle`,
      `1-${s}-izle-hdf-1`,
      `1-${s}-izle-6`,
      `${s}-izle`,
      `${s}-hdf`,
    );
  }

  const targetEn = ultraClean(info.originalTitle);
  const targetTr = ultraClean(info.title);

  for (const cand of candidates) {
    const pageHtml = await fetchText(`${base}/${cand}/`, {
      timeoutMs: 5_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!pageHtml) continue;
    const imdbInPage = /imdb\.com\/title\/(tt\d+)/i.exec(pageHtml)?.[1];
    if (imdbInPage && info.imdbId && imdbInPage === info.imdbId) {
      return cand;
    }
    const pageTitle = ultraClean(
      html.parse(pageHtml).selectOne("title")?.text() ?? "",
    );
    if (
      (targetEn && pageTitle.includes(targetEn)) ||
      (targetTr && pageTitle.includes(targetTr))
    ) {
      return cand;
    }
  }

  return null;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.hdfilmcehennemi.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const [latestHtml, topHtml] = await Promise.all([
        fetchText(`${base}/`, { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) }),
        fetchText(`${base}/imdb-7-puan-uzeri-filmler-2/`, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        }),
      ]);

      const sections: HomeSection[] = [];
      const latest = latestHtml ? dedupeMediaSummaries(parseCatalogPage(latestHtml, base)) : [];
      const top = topHtml ? dedupeMediaSummaries(parseCatalogPage(topHtml, base)) : [];
      if (latest.length > 0) {
        sections.push({ id: "latest", title: "Yeni Eklenenler", layout: "poster", items: latest });
      }
      if (top.length > 0) {
        sections.push({ id: "imdb-top", title: "IMDb 7+ Filmler", layout: "poster", items: top });
      }
      return { sections };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(query, _filters, page): Promise<SearchPage> {
    try {
      if (page > 1 || !query.trim()) return { items: [], hasMore: false };
      const base = await resolveBaseUrl(
        "urls.movies.hdfilmcehennemi.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const htmlText = await fetchText(
        `${base}/search?q=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
      );
      const items = htmlText ? parseCatalogPage(htmlText, base) : [];
      if (items.length > 0) return { items, hasMore: false };

      const guessed = slugify(query);
      if (guessed) {
        const directHtml = await fetchText(`${base}/${guessed}/`, {
          timeoutMs: 5_000,
          headers: buildHeaders(`${base}/`),
        });
        if (directHtml) {
          const doc = html.parse(directHtml);
          const title = decodeHtmlEntities(
            doc.selectOne("h1")?.text() || doc.selectOne("title")?.text() || query,
          ).trim();
          const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
          return {
            items: [{ nativeId: `movie:${guessed}`, type: "movie", title, poster }],
            hasMore: false,
          };
        }
      }
      return { items: [], hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl(
      "urls.movies.hdfilmcehennemi.base",
      DEFAULT_BASE,
      "mirrorUrl",
    );
    const slug = nativeId.replace(/^movie:/, "");
    const pageHtml = await fetchText(`${base}/${slug}/`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!pageHtml) throw new Error(`HDFilmCehennemi film bulunamadı: ${slug}`);

    const doc = html.parse(pageHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() ||
        doc.selectOne("title")?.text().split("-")[0] ||
        slug,
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;

    return {
      nativeId: `movie:${slug}`,
      type: "movie",
      title,
      year: extractYear(title),
      poster,
      backdrop: poster,
      episodes: [{ streamId: `movie:${slug}`, season: 1, episode: 1, title }],
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.hdfilmcehennemi.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const slug = streamId.startsWith("movie:")
        ? streamId.slice(6)
        : await resolveSlugFromTmdb(streamId, base);
      if (!slug) return { streams: [] };

      const pageUrl = `${base}/${slug}/`;
      const pageHtml = await fetchText(pageUrl, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      if (!pageHtml) return { streams: [] };

      const doc = html.parse(pageHtml);
      const embedUrls: string[] = [];
      for (const el of doc.select('iframe[src*="video/embed"], [data-src*="video/embed"]')) {
        const u = el.attr("data-src") || el.attr("src");
        if (u) embedUrls.push(absoluteUrl(base, u));
      }

      const streams: StreamCandidate[] = [];
      for (const embedUrl of embedUrls) {
        const res = await extractCloseLoad(
          embedUrl,
          `${base}/`,
          "HDFilmCehennemi",
        );
        streams.push(...res.streams);
        if (streams.length > 0) break;
      }

      return finalizeStreams(streams);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
