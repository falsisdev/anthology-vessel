import { definePlugin, html } from "vessel";
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
import {
  buildHeaders,
  fetchText,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import { createStream } from "./shared/core/quality.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractYear,
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://kultfilmler.net";

function parseKultCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const card of doc.select("a.mcard[href]")) {
    const href = card.attr("href");
    if (!href) continue;
    const fullUrl = absoluteUrl(base, href);
    if (seen.has(fullUrl)) continue;

    const img = card.selectOne("img.pimg, img");
    const rawTitle =
      card.selectOne(".mtx h3, h3")?.text() || img?.attr("alt") || "";
    const title = decodeHtmlEntities(rawTitle).trim();
    if (!title) continue;

    seen.add(fullUrl);
    const kind: "movie" | "series" = fullUrl.includes("/dizi/") ? "series" : "movie";
    const poster = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `${kind}:${encodeURIComponent(fullUrl)}`,
      type: kind,
      title,
      year: extractYear(title),
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return items;
}

async function resolvePageStreams(
  pageUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const rawHtml = await fetchText(pageUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!rawHtml) return [];

  const doc = html.parse(rawHtml);
  const iframes: string[] = [];
  const pushUrl = (raw?: string | null): void => {
    if (!raw) return;
    const full = absoluteUrl(base, raw.replace(/\\\//g, "/"));
    if (full && !iframes.includes(full)) iframes.push(full);
  };

  pushUrl(doc.selectOne("#player iframe")?.attr("src"));
  pushUrl(doc.selectOne(".kf-embed iframe")?.attr("src"));

  const srcScript = doc.selectOne("#kf-srcdata")?.html() ?? "";
  if (srcScript) {
    const re = /src=\\?"([^"\\]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(srcScript)) !== null) {
      pushUrl(m[1]);
    }
  }

  for (const ifr of iframes) {
    if (ifr.includes("youtube.com") || ifr.includes("youtu.be")) continue;
    const extracted = await extractByEmbedUrl(ifr, {
      sourceLabel: "KultFilmler",
      referer: pageUrl,
    });
    if (extracted.length > 0) return extracted;

    const directHtml = await fetchText(ifr, {
      timeoutMs: 8_000,
      headers: buildHeaders(pageUrl),
    });
    const m3u8 = directHtml
      ? /https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/i.exec(directHtml)?.[0]
      : null;
    if (m3u8 && !/preview|thumb|sprite/i.test(m3u8)) {
      return [
        createStream({
          url: m3u8,
          kind: "hls",
          quality: "1080p",
          label: "KultFilmler • Direct HLS",
          headers: buildHeaders(ifr),
        }),
      ];
    }
  }

  return [];
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.kultfilmler.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const htmlText = await fetchText(`${base}/category/aksiyon-filmleri-izle/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const items = htmlText ? parseKultCards(htmlText, base) : [];
      return {
        sections:
          items.length > 0
            ? [{ id: "action", title: "Öne Çıkan Filmler", layout: "poster", items }]
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
        "urls.movies.kultfilmler.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const htmlText = await fetchText(
        `${base}/?s=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 10_000, headers: buildHeaders(`${base}/`) },
      );
      const items = htmlText ? parseKultCards(htmlText, base) : [];
      return { items, hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl(
      "urls.movies.kultfilmler.base",
      DEFAULT_BASE,
      "mirrorUrl",
    );
    const targetUrl = decodeURIComponent(nativeId.replace(/^(?:movie|series):/, ""));
    const rawHtml = await fetchText(targetUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`KultFilmler sayfası açılamadı: ${targetUrl}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1.sec-h, h2.sec-h, h1")?.text().replace(/İzle\s*$/i, "") ||
        "KultFilmler",
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;

    if (targetUrl.includes("/dizi/")) {
      const episodes: Episode[] = [];
      const seen = new Set<string>();
      for (const epLink of doc.select("a.ep[href]")) {
        const href = epLink.attr("href");
        if (!href) continue;
        const full = absoluteUrl(base, href);
        if (seen.has(full)) continue;
        seen.add(full);
        const epText = epLink.text().trim();
        const parsed = parseSeasonEpisode(
          epText,
          Number.parseInt(epLink.attr("data-season") ?? "1", 10) || 1,
        );
        const season = parsed?.season ?? 1;
        const episode = parsed?.episode ?? episodes.length + 1;
        episodes.push({
          streamId: `ep:${encodeURIComponent(full)}`,
          season,
          episode,
          title: epText || `${season}. Sezon ${episode}. Bölüm`,
        });
      }
      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
      const seasons: SeasonSummary[] = Array.from(
        new Set(episodes.map((e) => e.season)),
      ).map((s) => ({
        id: String(s),
        season: s,
        title: `${s}. Sezon`,
        episodeCount: episodes.filter((e) => e.season === s).length,
      }));
      return {
        nativeId,
        type: "series",
        title,
        year: extractYear(title),
        poster,
        backdrop: poster,
        seasons,
        episodes,
      };
    }

    return {
      nativeId,
      type: "movie",
      title,
      year: extractYear(title),
      poster,
      backdrop: poster,
      episodes: [
        { streamId: `movie:${encodeURIComponent(targetUrl)}`, season: 1, episode: 1, title },
      ],
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.kultfilmler.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );

      if (streamId.startsWith("movie:") || streamId.startsWith("ep:")) {
        const pageUrl = decodeURIComponent(streamId.split(":").slice(1).join(":"));
        return finalizeStreams(await resolvePageStreams(pageUrl, base));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[1] && parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };

      for (const q of [identity.title, identity.originalTitle].filter(Boolean)) {
        const sHtml = await fetchText(`${base}/?s=${encodeURIComponent(q)}`, {
          timeoutMs: 10_000,
          headers: buildHeaders(`${base}/`),
        });
        if (!sHtml) continue;
        const cards = parseKultCards(sHtml, base).map((c) => ({
          title: c.title,
          year: c.year,
          type: c.type,
          url: decodeURIComponent(c.nativeId.replace(/^(?:movie|series):/, "")),
        }));
        const filtered = cards.filter((c) => c.type === identity.mediaType);
        const best = pickBestCandidate(
          filtered.length > 0 ? filtered : cards,
          identity.title,
          identity.originalTitle,
          identity.year,
        );
        if (best) {
          return finalizeStreams(await resolvePageStreams(best.url, base));
        }
      }

      return { streams: [] };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
