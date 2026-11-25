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
  postForm,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import {
  dedupeMediaSummaries,
  finalizeStreams,
  pickBestCandidate,
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
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://www.hdfilmcehennemi.land";

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
  let rel = full.slice(base.length).replace(/^\/+|\/+$/g, "");
  if (!rel) return null;
  if (rel.startsWith("film/")) rel = rel.slice(5);
  if (!rel || rel.includes("/")) return null;
  if (TAXONOMY_PREFIXES.some((p) => rel.startsWith(p))) return null;
  return rel;
}

function parseCatalogPage(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const box of doc.select("article.item, .result-item article, article")) {
    const a = box.selectOne('a[href*="/film/"], a[href]');
    const href = a?.attr("href");
    if (!href) continue;
    const slug = extractSlugFromHref(href, base);
    if (!slug || seen.has(slug)) continue;
    const img = box.selectOne("img");
    const rawTitle =
      box.selectOne(".data h3, .title h3, .title, h2, h3")?.text() ||
      a?.attr("title") ||
      img?.attr("alt") ||
      "";
    const title = decodeHtmlEntities(rawTitle)
      .replace(/\s*(?:-|izle\s*\|).*$/i, "")
      .replace(/\s+izle$/i, "")
      .trim();
    if (!title || title.length < 2) continue;
    seen.add(slug);
    const rawPoster = img?.attr("data-src") || img?.attr("src");
    const poster =
      rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined;
    items.push({
      nativeId: `movie:${encodeURIComponent(absoluteUrl(base, href))}`,
      type: "movie",
      title,
      year: extractYear(title) ?? extractYear(box.selectOne(".metadata, .data span")?.text()),
      poster,
    });
    if (items.length >= 40) break;
  }

  if (items.length === 0) {
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
      const rawPoster = img?.attr("data-src") || img?.attr("src");
      items.push({
        nativeId: `movie:${encodeURIComponent(absoluteUrl(base, href))}`,
        type: "movie",
        title,
        year: extractYear(title),
        poster: rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined,
      });
      if (items.length >= 40) break;
    }
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
      const [latestHtml, dubHtml] = await Promise.all([
        fetchText(`${base}/`, { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) }),
        fetchText(`${base}/turkce-dublaj-filmler-izle-1/`, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        }),
      ]);

      const sections: HomeSection[] = [];
      const latest = latestHtml ? dedupeMediaSummaries(parseCatalogPage(latestHtml, base)) : [];
      const dub = dubHtml ? dedupeMediaSummaries(parseCatalogPage(dubHtml, base)) : [];
      if (latest.length > 0) {
        sections.push({ id: "latest", title: "Yeni Eklenenler", layout: "poster", items: latest });
      }
      if (dub.length > 0) {
        sections.push({ id: "dub", title: "Türkçe Dublaj Filmler", layout: "poster", items: dub });
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
      const htmlText =
        (await fetchText(`${base}/?s=${encodeURIComponent(query.trim())}`, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        })) ??
        (await fetchText(`${base}/search?q=${encodeURIComponent(query.trim())}`, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        }));
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
    const rawTarget = nativeId.replace(/^movie:/, "");
    let pageUrl: string;
    try {
      const dec = decodeURIComponent(rawTarget);
      pageUrl = dec.startsWith("http") ? dec : `${base}/${rawTarget.replace(/^\/+|\/+$/g, "")}/`;
    } catch {
      pageUrl = `${base}/${rawTarget.replace(/^\/+|\/+$/g, "")}/`;
    }
    const pageHtml = await fetchText(pageUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!pageHtml) throw new Error(`HDFilmCehennemi film bulunamadı: ${pageUrl}`);

    const doc = html.parse(pageHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() ||
        doc.selectOne("title")?.text().split("-")[0]?.split("|")[0] ||
        rawTarget,
    )
      .replace(/\s+izle$/i, "")
      .trim();
    const rawPoster =
      doc.selectOne('meta[property="og:image"]')?.attr("content") ??
      doc.selectOne(".poster img")?.attr("src");
    const poster =
      rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined;

    return {
      nativeId,
      type: "movie",
      title,
      year: extractYear(title),
      poster,
      backdrop: poster,
      episodes: [{ streamId: `movie:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title }],
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.hdfilmcehennemi.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      let pageUrl = "";
      if (streamId.startsWith("movie:")) {
        const raw = decodeURIComponent(streamId.slice(6));
        pageUrl = raw.startsWith("http") ? raw : `${base}/${raw.replace(/^\/+|\/+$/g, "")}/`;
      } else {
        const cleanId = streamId.split(":")[0]?.trim() ?? streamId;
        const identity = await resolveTmdbIdentity(cleanId, "movie");
        if (identity) {
          for (const q of [identity.title, identity.originalTitle].filter(Boolean)) {
            const sr = await this.search!(q, {}, 1);
            const best = pickBestCandidate(
              sr.items.map((x) => ({ title: x.title, year: x.year, nativeId: x.nativeId })),
              identity.title,
              identity.originalTitle,
              identity.year,
            );
            if (best) {
              const dec = decodeURIComponent(best.nativeId.replace(/^movie:/, ""));
              pageUrl = dec.startsWith("http") ? dec : `${base}/${dec.replace(/^\/+|\/+$/g, "")}/`;
              break;
            }
          }
        }
        if (!pageUrl) {
          const slug = await resolveSlugFromTmdb(streamId, base);
          if (slug) pageUrl = `${base}/${slug}/`;
        }
      }
      if (!pageUrl) return { streams: [] };

      const pageHtml = await fetchText(pageUrl, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      if (!pageHtml) return { streams: [] };

      const doc = html.parse(pageHtml);
      const streams: StreamCandidate[] = [];

      // 1. SetPlay / OldMovie AJAX (`hdfilmcehennemi.land`)
      const ajaxUrl =
        /ajaxurl\s*:\s*["']([^"']+)["']/.exec(pageHtml)?.[1]?.replace(/\\\//g, "/") ??
        `${base}/wp-admin/admin-ajax.php`;
      const nonce =
        /nonce\s*:\s*["']([a-z0-9]+)["']/i.exec(pageHtml)?.[1] ??
        doc.selectOne("[data-nonce]")?.attr("data-nonce");
      const playerBtns = doc
        .select("[data-post-id][data-player-name]")
        .map((el) => ({
          postId: el.attr("data-post-id") ?? "",
          name: el.attr("data-player-name") ?? "",
          key: el.attr("data-part-key") ?? "",
        }))
        .filter((b) => b.postId && b.name && !b.name.includes("$"));

      if (nonce && playerBtns.length > 0) {
        const ajaxResults = await Promise.all(
          playerBtns.slice(0, 4).map(async (btn) => {
            const res = await postForm(
              ajaxUrl,
              {
                action: "get_video_url",
                nonce,
                post_id: btn.postId,
                player_name: btn.name,
                part_key: btn.key,
              },
              {
                timeoutMs: 10_000,
                headers: {
                  Referer: pageUrl,
                  Origin: new URL(pageUrl).origin,
                  "X-Requested-With": "XMLHttpRequest",
                },
              },
            );
            if (!res || res.status < 200 || res.status >= 300) return [];
            let targetUrl = "";
            try {
              const j = res.json<{ success?: boolean; data?: { url?: string } }>();
              targetUrl = j.data?.url?.replace(/\\\//g, "/") ?? "";
            } catch {
              return [];
            }
            if (!targetUrl) return [];
            return extractByEmbedUrl(targetUrl, {
              sourceLabel: "HDFilmCehennemi",
              referer: pageUrl,
            });
          }),
        );
        streams.push(...ajaxResults.flat());
      }

      // 2. Legacy CloseLoad iframe fallback (`hdfilmcehennemi.nl`)
      if (streams.length === 0) {
        const embedUrls: string[] = [];
        for (const el of doc.select('iframe[src*="video/embed"], [data-src*="video/embed"]')) {
          const u = el.attr("data-src") || el.attr("src");
          if (u) embedUrls.push(absoluteUrl(base, u));
        }
        for (const embedUrl of embedUrls) {
          const res = await extractCloseLoad(
            embedUrl,
            `${base}/`,
            "HDFilmCehennemi",
          );
          streams.push(...res.streams);
          if (streams.length > 0) break;
        }
      }

      return finalizeStreams(streams);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
