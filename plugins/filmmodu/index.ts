import { definePlugin, html } from "vessel";
import type {
  AudioType,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  StreamCandidate,
  SubtitleTrack,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchJson,
  fetchText,
  rethrowIfDomainBlocked,
  safeRequest,
} from "./shared/core/http.ts";
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import { createStream } from "./shared/core/quality.ts";
import {
  absoluteUrl,
  cleanTitle,
  decodeHtmlEntities,
  extractYear,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractPilavyer } from "./shared/extractors/pilavyer.ts";

const DEFAULT_BASE = "https://www.filmmodu.one";
const DEFAULT_LIVE = "https://filmmodu.live";

interface FilmModuSourceResponse {
  subtitle?: string;
  sources?: Array<{ src?: string; label?: string; res?: number | string }>;
}

function parseFilmModuCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const box of doc.select("div.movie")) {
    const a = box.selectOne("a[href]");
    const img = box.selectOne("img");
    const href = a?.attr("href");
    if (!href) continue;

    const fullUrl = absoluteUrl(base, href);
    const slug = fullUrl.replace(base, "").replace(/^\/+|\/+$/g, "");
    if (!slug || seen.has(slug)) continue;

    const rawTitle = a?.text() || img?.attr("alt") || "";
    const title = decodeHtmlEntities(rawTitle).trim();
    if (!title) continue;

    seen.add(slug);
    const poster = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `movie:${encodeURIComponent(slug)}`,
      type: "movie",
      title,
      year: extractYear(title),
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return items;
}

async function resolveAltLinks(
  filmUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const filmHtml = await fetchText(filmUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!filmHtml) return [];

  const doc = html.parse(filmHtml);
  const alts: Array<{ href: string; name: string }> = [];
  for (const a of doc.select("div.alternates a[href]")) {
    const name = a.text().trim();
    const href = a.attr("href");
    if (!name || !href || name.toLowerCase().includes("fragman")) continue;
    const full = absoluteUrl(base, href);
    if (!alts.some((x) => x.href === full)) {
      alts.push({ href: full, name });
    }
  }
  if (alts.length === 0) alts.push({ href: filmUrl, name: "Ana Kaynak" });

  const out: StreamCandidate[] = [];
  for (const alt of alts) {
    const altHtml = await fetchText(alt.href, {
      timeoutMs: 8_000,
      headers: buildHeaders(filmUrl),
    });
    if (!altHtml) continue;
    const videoId = /var\s+videoId\s*=\s*'([^']+)'/.exec(altHtml)?.[1];
    const videoType = /var\s+videoType\s*=\s*'([^']*)'/.exec(altHtml)?.[1] ?? "";
    if (!videoId) continue;

    const srcData = await fetchJson<FilmModuSourceResponse>(
      `${base}/get-source?movie_id=${encodeURIComponent(videoId)}&type=${encodeURIComponent(videoType)}`,
      {
        timeoutMs: 8_000,
        headers: {
          Referer: alt.href,
          "X-Requested-With": "XMLHttpRequest",
        },
      },
    );
    if (!srcData?.sources?.length) continue;

    const subtitles: SubtitleTrack[] = [];
    if (srcData.subtitle) {
      subtitles.push({
        id: "tr_0",
        source: {
          kind: "url",
          url: absoluteUrl(base, srcData.subtitle),
          headers: buildHeaders(`${base}/`),
        },
        lang: "tr",
        label: "Türkçe",
        format: "vtt",
        isDefault: true,
      });
    }

    const audioLower = alt.name.toLowerCase();
    const audioType: AudioType | undefined = audioLower.includes("dublaj")
      ? "dub"
      : audioLower.includes("altyaz")
        ? "sub"
        : undefined;

    for (const src of srcData.sources) {
      if (!src.src) continue;
      const playUrl = src.src.includes(".m3u8") ? src.src : `${src.src}.m3u8`;
      const quality =
        src.label || (src.res ? `${src.res}p` : "1080p");
      out.push(
        createStream({
          url: playUrl,
          kind: "hls",
          quality: String(quality),
          label: `FilmModu • ${alt.name} • ${quality}`,
          audioType,
          language: audioType === "dub" ? "tr" : undefined,
          headers: buildHeaders(`${base}/`),
          subtitles: subtitles.length > 0 ? subtitles : undefined,
        }),
      );
    }
  }
  return out;
}

async function resolveFromLiveFallback(
  rawTitle: string,
  year: number | undefined,
  liveUrl: string,
  playerHost: string,
): Promise<StreamCandidate[]> {
  const q = cleanTitle(rawTitle);
  if (!q) return [];
  const searchHtml = await fetchText(
    `${liveUrl}/ara?q=${encodeURIComponent(q)}`,
    { timeoutMs: 10_000, headers: buildHeaders(`${liveUrl}/`) },
  );
  if (!searchHtml) return [];

  const doc = html.parse(searchHtml);
  const cands: Array<{ href: string; title: string; year?: number }> = [];
  for (const a of doc.select("a[href*='/film/']")) {
    const href = a.attr("href");
    if (!href) continue;
    const title =
      a.selectOne("h3")?.text() || a.selectOne("img")?.attr("alt") || a.text();
    const yrText = a.selectOne("p")?.text() || "";
    cands.push({
      href: absoluteUrl(liveUrl, href),
      title: decodeHtmlEntities(title).trim(),
      year: extractYear(yrText),
    });
  }

  const best = pickBestCandidate(cands, q, undefined, year);
  if (!best) return [];

  const filmHtml = await fetchText(best.href, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${liveUrl}/`),
  });
  const pvId = filmHtml ? /data-pv="([^"]+)"/.exec(filmHtml)?.[1] : null;
  if (!pvId) return [];

  const pv = await extractPilavyer({
    pvId,
    playerHost,
    referer: `${liveUrl}/`,
    sourceLabel: "FilmModu",
  });
  return pv.streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.filmmodu.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const htmlText = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const items = htmlText ? parseFilmModuCards(htmlText, base) : [];
      return {
        sections:
          items.length > 0
            ? [{ id: "latest", title: "Yeni Filmler", layout: "poster", items }]
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
        "urls.movies.filmmodu.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const searchUrl = `${base}/film-ara?term=${encodeURIComponent(cleanTitle(query))}`;
      const res = await safeRequest(searchUrl, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      if (!res || res.status < 200 || res.status >= 400) {
        return { items: [], hasMore: false };
      }
      const body = res.text();
      const doc = html.parse(body);

      if (doc.selectOne("div.alternates")) {
        const canonical = doc.selectOne('link[rel="canonical"]')?.attr("href") || res.url;
        const slug = canonical.replace(base, "").replace(/^\/+|\/+$/g, "");
        const title = doc.selectOne("h1")?.text() || query;
        const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
        return {
          items: [
            {
              nativeId: `movie:${encodeURIComponent(slug)}`,
              type: "movie",
              title,
              poster,
            },
          ],
          hasMore: false,
        };
      }

      return { items: parseFilmModuCards(body, base), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl(
      "urls.movies.filmmodu.base",
      DEFAULT_BASE,
      "mirrorUrl",
    );
    const slug = decodeURIComponent(nativeId.replace(/^movie:/, ""));
    const filmUrl = slug.startsWith("http") ? slug : `${base}/${slug}`;
    const filmHtml = await fetchText(filmUrl, { headers: buildHeaders(`${base}/`) });
    if (!filmHtml) throw new Error(`FilmModu içerik açılamadı: ${slug}`);

    const doc = html.parse(filmHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() ||
        doc.selectOne("title")?.text().split("-")[0] ||
        slug,
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;

    return {
      nativeId,
      type: "movie",
      title,
      year: extractYear(title),
      poster,
      backdrop: poster,
      episodes: [{ streamId: `movie:${encodeURIComponent(slug)}`, season: 1, episode: 1, title }],
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.filmmodu.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const liveUrl = await resolveBaseUrl("urls.movies.filmmodu.live", DEFAULT_LIVE);
      const playerHost = await resolveBaseUrl(
        "urls.movies.filmmodu.player",
        "https://play2.pilavyerplay.top",
      );

      if (streamId.startsWith("movie:")) {
        const slug = decodeURIComponent(streamId.slice(6));
        const filmUrl = slug.startsWith("http") ? slug : `${base}/${slug}`;
        const streams = await resolveAltLinks(filmUrl, base);
        if (streams.length > 0) return finalizeStreams(streams);
        const liveStreams = await resolveFromLiveFallback(
          slug.replace(/-/g, " "),
          undefined,
          liveUrl,
          playerHost,
        );
        return finalizeStreams(liveStreams);
      }

      const tmdbRaw = streamId.split(":")[0] ?? streamId;
      const identity = await resolveTmdbIdentity(tmdbRaw, "movie");
      if (!identity) return { streams: [] };

      let targetFilmUrl = "";
      for (const q of [identity.originalTitle, identity.title].filter(Boolean)) {
        const searchUrl = `${base}/film-ara?term=${encodeURIComponent(cleanTitle(q))}`;
        const res = await safeRequest(searchUrl, { headers: buildHeaders(`${base}/`) });
        if (!res || res.status >= 400) continue;
        const body = res.text();
        const doc = html.parse(body);
        if (doc.selectOne("div.alternates")) {
          targetFilmUrl = doc.selectOne('link[rel="canonical"]')?.attr("href") || res.url;
          break;
        }
        const cards = parseFilmModuCards(body, base).map((c) => ({
          title: c.title,
          year: c.year,
          slug: decodeURIComponent(c.nativeId.replace(/^movie:/, "")),
        }));
        const best = pickBestCandidate(
          cards,
          identity.title,
          identity.originalTitle,
          identity.year,
        );
        if (best) {
          targetFilmUrl = `${base}/${best.slug}`;
          break;
        }
      }

      const streams = targetFilmUrl
        ? await resolveAltLinks(targetFilmUrl, base)
        : [];
      if (streams.length > 0) return finalizeStreams(streams);

      const liveStreams = await resolveFromLiveFallback(
        identity.originalTitle || identity.title,
        identity.year,
        liveUrl,
        playerHost,
      );
      return finalizeStreams(liveStreams);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
