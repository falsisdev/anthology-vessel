import { definePlugin, html, unpack } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
  StreamCandidate,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import { buildHeaders, fetchJson, fetchText, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import { absoluteUrl, decodeHtmlEntities } from "./shared/core/text.ts";
import { resolveTmdbIdentity, tmdbBuildMediaDetail, tmdbSearch } from "./shared/core/tmdb.ts";
import {
  collectAnimeSearchTitles,
  discoverPopularAnime,
  resolveDiziWatchAnimeFallback,
} from "./shared/core/anime-helpers.ts";
import { extractAnizmPlayer, extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://anizm.net";

interface AnizmV3SearchItem {
  title?: string;
  slug?: string;
  url?: string;
  poster?: string;
}

interface AnizmV2SearchResponse {
  data?: Array<{
    info_slug?: string;
    info_title?: string;
    info_titleenglish?: string;
    info_poster?: string;
  }>;
}

async function searchAnizmNative(query: string, base: string): Promise<MediaSummary[]> {
  const ajaxHeaders = {
    ...buildHeaders(`${base}/`),
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json, text/plain, */*",
  };

  const v3Raw = await fetchJson<AnizmV3SearchItem[] | { results?: AnizmV3SearchItem[] }>(
    `${base}/arama-onerileri?q=${encodeURIComponent(query)}`,
    { timeoutMs: 3_500, headers: ajaxHeaders },
  );
  const v3 = Array.isArray(v3Raw) ? v3Raw : (v3Raw?.results ?? []);
  if (v3.length > 0) {
    return v3
      .map<MediaSummary | null>((it) => {
        const slug = it.slug || it.url?.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "");
        if (!slug) return null;
        return {
          nativeId: `anime:${slug}`,
          type: "series",
          isAnime: true,
          title: decodeHtmlEntities(it.title || slug).trim(),
          poster: it.poster
            ? it.poster.startsWith("http")
              ? it.poster
              : `https://cdn.anizm.net/storage/pcovers/${it.poster}`
            : undefined,
        };
      })
      .filter((x): x is MediaSummary => x !== null);
  }

  const v2 = await fetchJson<AnizmV2SearchResponse>(
    `${base}/searchAnime?query=${encodeURIComponent(query)}&page=1`,
    { timeoutMs: 3_500, headers: ajaxHeaders },
  );
  return (v2?.data ?? [])
    .filter((it) => Boolean(it.info_slug))
    .map<MediaSummary>((it) => ({
      nativeId: `anime:${it.info_slug!}`,
      type: "series",
      isAnime: true,
      title: decodeHtmlEntities(it.info_title || it.info_titleenglish || it.info_slug!).trim(),
      poster: it.info_poster
        ? it.info_poster.startsWith("http")
          ? it.info_poster
          : `https://cdn.anizm.net/storage/pcovers/${it.info_poster}`
        : undefined,
    }));
}

async function resolveAnizmPlayerPage(vidUrl: string, base: string): Promise<StreamCandidate[]> {
  let playerHtml: string | null = null;
  if (vidUrl.includes("/bolum/")) {
    const j = await fetchJson<{ url?: string }>(vidUrl, {
      timeoutMs: 6_000,
      headers: { ...buildHeaders(`${base}/`), "X-Requested-With": "XMLHttpRequest" },
    });
    if (j?.url) {
      playerHtml = await fetchText(j.url, { timeoutMs: 7_000, headers: buildHeaders(`${base}/`) });
    }
  }
  if (!playerHtml) {
    const vidId = /\/video\/(\d+)/.exec(vidUrl)?.[1];
    if (vidId) {
      playerHtml = await fetchText(`${base}/player/${vidId}`, {
        timeoutMs: 7_000,
        headers: buildHeaders(`${base}/`),
      });
    }
  }
  if (!playerHtml) return [];

  const streams: StreamCandidate[] = [];
  const evals = Array.from(
    playerHtml.matchAll(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?<\/script>/gi),
  );
  for (const m of evals) {
    const unpacked = unpack(m[0].replace(/<\/script>$/i, "").trim());
    const fp = /FirePlayer\(["']([^"']+)["']/.exec(unpacked);
    if (fp?.[1]) {
      streams.push(
        ...(await extractAnizmPlayer(fp[1], {
          sourceLabel: "Anizm",
          audioType: "sub",
          language: "ja",
          referer: `${base}/`,
        })),
      );
      break;
    }
  }

  for (const m of playerHtml.matchAll(/(?:src|data-src|href)=["']([^"']*(?:ok\.ru\/videoembed|video\.sibnet\.ru)[^"']+)["']/gi)) {
    if (m[1]) {
      streams.push(
        ...(await extractByEmbedUrl(m[1], {
          sourceLabel: "Anizm",
          audioType: "sub",
          language: "ja",
          referer: `${base}/`,
        })),
      );
    }
  }
  return streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.anime.anizm.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 3_500,
        headers: buildHeaders(`${base}/`),
      });

      const items: MediaSummary[] = [];
      const seen = new Set<string>();
      if (rawHtml) {
        const doc = html.parse(rawHtml);
        for (const art of doc.select("article.v3-series-card, article.v3-episode-card")) {
          const a = art.selectOne("a[href]");
          const href = a?.attr("href");
          if (!href) continue;
          const full = absoluteUrl(base, href);
          const slug = full
            .replace(/^https?:\/\/[^/]+\//, "")
            .replace(/-\d+-bolum(?:-(?:final|izle|fragman))*$/i, "")
            .replace(/\/+$/, "");
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);
          const img = art.selectOne("img");
          const title = decodeHtmlEntities(img?.attr("alt") || a?.text() || slug)
            .replace(/\s+posteri$/i, "")
            .trim();
          const poster = img?.attr("data-src") || img?.attr("src");
          items.push({
            nativeId: `anime:${slug}`,
            type: "series",
            isAnime: true,
            title: title || slug,
            poster: poster ? absoluteUrl(base, poster) : undefined,
          });
          if (items.length >= 30) break;
        }
      }

      if (items.length === 0) {
        items.push(...(await discoverPopularAnime("anizm")));
      }

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
      const base = await resolveBaseUrl("urls.anime.anizm.base", DEFAULT_BASE, "mirrorUrl");
      const nativeHits = await searchAnizmNative(query.trim(), base);
      if (nativeHits.length > 0) return { items: nativeHits, hasMore: false };

      return tmdbSearch({
        idPrefix: "anizm",
        query: query.trim(),
        mediaType: "series",
        isAnime: true,
        page: 1,
      });
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    if (nativeId.startsWith("anizm:series:") || nativeId.startsWith("anizm:movie:")) {
      const det = await tmdbBuildMediaDetail({
        nativeId,
        preferType: "series",
        isAnime: true,
        streamIdBuilder: (identity, s, e) => `tmdb:${identity.tmdbId}:${s}:${e}`,
      });
      if (det) return det;
    }

    const base = await resolveBaseUrl("urls.anime.anizm.base", DEFAULT_BASE, "mirrorUrl");
    const slug = nativeId.replace(/^anime:/, "");
    const rawHtml =
      (await fetchText(`${base}/${slug}`, {
        timeoutMs: 8_000,
        headers: buildHeaders(`${base}/`),
      })) ??
      (await fetchText(`${base}/anime/${slug}`, {
        timeoutMs: 8_000,
        headers: buildHeaders(`${base}/`),
      }));
    if (!rawHtml) throw new Error(`Anizm anime açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne(".animeTitle, h1")?.text() || slug,
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<number>();

    for (const a of doc.select('a[href*="-bolum"]')) {
      const href = a.attr("href");
      if (!href) continue;
      const m = /-(\d+)-bolum/i.exec(href) ?? /(\d+)/.exec(a.text());
      const epNum = m?.[1] ? Number.parseInt(m[1], 10) : 0;
      if (epNum < 1 || seen.has(epNum)) continue;
      seen.add(epNum);
      episodes.push({
        streamId: `ep:${slug}:1:${epNum}`,
        season: 1,
        episode: epNum,
        title: `${epNum}. Bölüm`,
      });
    }
    episodes.sort((a, b) => a.episode - b.episode);
    const seasons: SeasonSummary[] =
      episodes.length > 0
        ? [{ id: "1", season: 1, title: "1. Sezon", episodeCount: episodes.length }]
        : [];

    return {
      nativeId,
      type: "series",
      isAnime: true,
      title,
      poster,
      backdrop: poster,
      genres: ["Anime"],
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.anime.anizm.base", DEFAULT_BASE, "mirrorUrl");
      let slug = "";
      let sNum = 1;
      let eNum = 1;
      let fallbackTitles: string[] = [];

      if (streamId.startsWith("ep:") || streamId.startsWith("anime:")) {
        const parts = streamId.split(":");
        slug = parts[1] ?? "";
        sNum = Number.parseInt(parts[2] ?? "1", 10) || 1;
        eNum = Number.parseInt(parts[3] ?? "1", 10) || 1;
        const cleanSlugTitle = slug
          .replace(/(?:-?(?:izle|hd|turkce|altyazili|sezon-\d+))+$/gi, "")
          .replace(/-/g, " ")
          .trim();
        fallbackTitles = cleanSlugTitle ? [cleanSlugTitle] : [];
      } else {
        const parts = streamId.split(":");
        const idToken =
          streamId.startsWith("tmdb:") || streamId.startsWith("anizm:")
            ? parts[1] ?? streamId
            : parts[0] ?? streamId;
        const offset = streamId.startsWith("tmdb:") || streamId.startsWith("anizm:") ? 2 : 1;
        sNum = Number.parseInt(parts[offset] ?? "1", 10) || 1;
        eNum = Number.parseInt(parts[offset + 1] ?? "1", 10) || 1;

        const identity = await resolveTmdbIdentity(idToken, "series");
        if (identity) {
          fallbackTitles = collectAnimeSearchTitles(identity);
          for (const q of fallbackTitles.slice(0, 3)) {
            const hits = await searchAnizmNative(q, base);
            const best = pickBestCandidate(
              hits.map((x) => ({ title: x.title, nativeId: x.nativeId })),
              identity.title,
              identity.originalTitle,
            );
            if (best) {
              slug = best.nativeId.replace(/^anime:/, "");
              break;
            }
          }
        }
      }

      const out: StreamCandidate[] = [];
      if (slug) {
        for (const candUrl of [
          `${base}/${slug}-${eNum}-bolum-izle`,
          `${base}/${slug}-${eNum}-bolum`,
        ]) {
          const epHtml = await fetchText(candUrl, {
            timeoutMs: 7_000,
            headers: buildHeaders(`${base}/`),
          });
          if (!epHtml) continue;
          const transMatches = Array.from(
            epHtml.matchAll(/data-sources=["']([^"']+\/cevirmen\/\d+)["']/g),
          ).map((m) => m[1]!);

          let fails = 0;
          for (const tUrl of transMatches.slice(0, 3)) {
            if (fails >= 2 || out.length >= 4) break;
            const tJson = await fetchJson<{ videos?: Array<{ id?: number | string }> }>(tUrl, {
              timeoutMs: 6_000,
              headers: { ...buildHeaders(`${base}/`), "X-Requested-With": "XMLHttpRequest" },
            });
            for (const v of (tJson?.videos ?? []).slice(0, 3)) {
              if (!v.id || fails >= 2 || out.length >= 4) break;
              const vUrl = tUrl.replace(/\/cevirmen\/\d+$/, `/video/${v.id}`);
              const resolved = await resolveAnizmPlayerPage(vUrl, base);
              if (resolved.length > 0) {
                fails = 0;
                out.push(...resolved);
              } else {
                fails++;
              }
            }
          }
          if (out.length > 0) break;
        }
      }

      if (out.length === 0 && fallbackTitles.length > 0) {
        out.push(...(await resolveDiziWatchAnimeFallback(fallbackTitles, sNum, eNum, "Anizm")));
      }
      return finalizeStreams(out);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
