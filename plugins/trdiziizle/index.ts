import { definePlugin, html, unpack } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  StreamCandidate,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import { buildHeaders, fetchText, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import {
  dedupeMediaSummaries,
  extractUniqueFrameUrls,
  finalizeStreams,
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import { createStream } from "./shared/core/quality.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity, tmdbDiscoverFeed } from "./shared/core/tmdb.ts";
import {
  resolveYouTubeInnertube,
  searchOfficialYouTubeEpisode,
} from "./shared/extractors/youtube.ts";

const DEFAULT_BASE = "https://www.trdiziizle.tv/tr2";

function parseTrDiziCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select(".entry-title a[href], .post-title a[href], article a[href]")) {
    const href = a.attr("href");
    if (!href) continue;
    const full = absoluteUrl(base, href);
    if (seen.has(full)) continue;
    const rawTitle = a.text().trim() || a.attr("title") || "";
    const title = decodeHtmlEntities(rawTitle).trim();
    if (!title || title.length < 2) continue;
    seen.add(full);
    const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
    const poster = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `series:${encodeURIComponent(full)}`,
      type: "series",
      title,
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return items;
}

async function resolveIframe(src: string, base: string): Promise<StreamCandidate[]> {
  const abs = absoluteUrl(base, src);
  if (abs.includes("youtube") || abs.includes("youtu.be")) {
    const yt = await resolveYouTubeInnertube(abs, "TrDiziİzle");
    return yt?.streams ?? [];
  }

  const rawHtml = await fetchText(abs, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!rawHtml) return [];
  const unpacked = rawHtml.includes("eval(function(p,a,c,k,e,") ? unpack(rawHtml) : rawHtml;
  const pool = `${rawHtml}\n${unpacked}`;
  const out: StreamCandidate[] = [];
  const seen = new Set<string>();

  for (const match of pool.matchAll(/https?:[^"'\s\\]+\.(?:m3u8|mp4)(?:\?[^"'\s\\]*)?/gi)) {
    const u = match[0];
    if (/\.(?:png|jpe?g|gif|css|js|svg)(?:\?|$)/i.test(u) || seen.has(u)) continue;
    seen.add(u);
    const isHls = u.includes(".m3u8");
    out.push(
      createStream({
        url: u,
        kind: isHls ? "hls" : "mp4",
        quality: "1080p",
        label: `TrDiziİzle • 1080p ${isHls ? "HLS" : "MP4"}`,
        language: "tr",
        headers: buildHeaders(`${base}/`),
      }),
    );
  }
  return out;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.trdiziizle.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 5_000,
        headers: buildHeaders(`${base}/`),
      });
      const isParked = !rawHtml || rawHtml.includes("window.park") || rawHtml.includes("parked");
      let items = !isParked ? parseTrDiziCards(rawHtml, base) : [];
      if (items.length === 0) {
        items = await tmdbDiscoverFeed({
          idPrefix: "trdiziizle",
          mediaType: "series",
          originCountry: "TR",
        });
      }
      return {
        sections:
          items.length > 0
            ? [{ id: "tr-series", title: "Yerli Diziler", layout: "poster", items: dedupeMediaSummaries(items) }]
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
      const base = await resolveBaseUrl("urls.series.trdiziizle.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/?s=${encodeURIComponent(query.trim())}`, {
        timeoutMs: 8_000,
        headers: buildHeaders(`${base}/`),
      });
      const items = rawHtml && !rawHtml.includes("window.park") ? parseTrDiziCards(rawHtml, base) : [];
      if (items.length > 0) return { items, hasMore: false };

      return {
        items: [
          {
            nativeId: `yt:${encodeURIComponent(query.trim())}`,
            type: "series",
            title: query.trim(),
          },
        ],
        hasMore: false,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    if (nativeId.startsWith("trdiziizle:series:") || nativeId.startsWith("yt:")) {
      const queryOrId = nativeId.startsWith("yt:")
        ? decodeURIComponent(nativeId.slice(3))
        : nativeId.split(":")[2] ?? nativeId;
      const identity = await resolveTmdbIdentity(queryOrId, "series");
      const title = identity?.title || queryOrId;
      const episodes: Episode[] = [];
      const count = Math.min(identity?.seasons[0]?.episodeCount ?? 12, 30);
      for (let e = 1; e <= count; e++) {
        episodes.push({
          streamId: `yt:${encodeURIComponent(title)}:1:${e}`,
          season: 1,
          episode: e,
          title: `${e}. Bölüm`,
        });
      }
      return {
        nativeId,
        type: "series",
        title,
        poster: identity?.poster,
        backdrop: identity?.backdrop,
        synopsis: identity?.synopsis,
        episodes,
      };
    }

    const base = await resolveBaseUrl("urls.series.trdiziizle.base", DEFAULT_BASE, "mirrorUrl");
    const pageUrl = decodeURIComponent(nativeId.replace(/^series:/, ""));
    const rawHtml = await fetchText(pageUrl, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${base}/`),
    });
    const doc = rawHtml ? html.parse(rawHtml) : null;
    const title = decodeHtmlEntities(doc?.selectOne("h1")?.text() || "TrDiziİzle").trim();
    const poster = doc?.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    if (doc) {
      for (const a of doc.select('a[href*="bolum"]')) {
        const href = a.attr("href");
        if (!href) continue;
        const parsed = parseSeasonEpisode(a.text() || href, 1);
        const s = parsed?.season ?? 1;
        const e = parsed?.episode ?? episodes.length + 1;
        episodes.push({
          streamId: `ep:${encodeURIComponent(absoluteUrl(base, href))}`,
          season: s,
          episode: e,
          title: `${s}. Sezon ${e}. Bölüm`,
        });
      }
    }
    if (episodes.length === 0) {
      episodes.push({ streamId: `ep:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title });
    }
    return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.trdiziizle.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("yt:")) {
        const [, encodedTitle, , epStr] = streamId.split(":");
        const title = decodeURIComponent(encodedTitle ?? "");
        const epNum = Number.parseInt(epStr ?? "1", 10) || 1;
        return finalizeStreams(await searchOfficialYouTubeEpisode(title, epNum, "TrDiziİzle"));
      }
      if (streamId.startsWith("ep:")) {
        const epUrl = decodeURIComponent(streamId.slice(3));
        const epHtml = await fetchText(epUrl, { headers: buildHeaders(`${base}/`) });
        if (epHtml) {
          const frames = extractUniqueFrameUrls(epHtml, base);
          const streams: StreamCandidate[] = [];
          for (const f of frames) {
            streams.push(...(await resolveIframe(f, base)));
          }
          if (streams.length > 0) return finalizeStreams(streams);
        }
      }

      const parts = streamId.split(":");
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, "series");
      if (!identity) return { streams: [] };
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      const sHtml = await fetchText(`${base}/?s=${encodeURIComponent(identity.title)}`, {
        timeoutMs: 6_000,
        headers: buildHeaders(`${base}/`),
      });
      if (sHtml && !sHtml.includes("window.park")) {
        const cands = parseTrDiziCards(sHtml, base).map((c) => ({
          title: c.title,
          url: decodeURIComponent(c.nativeId.replace(/^series:/, "")),
        }));
        const best = pickBestCandidate(cands, identity.title, identity.originalTitle);
        if (best) {
          const epHtml = await fetchText(best.url, { headers: buildHeaders(`${base}/`) });
          if (epHtml) {
            for (const f of extractUniqueFrameUrls(epHtml, base)) {
              const resolved = await resolveIframe(f, base);
              if (resolved.length > 0) return finalizeStreams(resolved);
            }
          }
        }
      }

      return finalizeStreams(
        await searchOfficialYouTubeEpisode(identity.title, eTarget, "TrDiziİzle"),
      );
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
