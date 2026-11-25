import { definePlugin, html } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
  StreamCandidate,
  SubtitleTrack,
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
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import { createStream } from "./shared/core/quality.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://www.diziyou.one";
const DEFAULT_STORAGE = "https://storage.diziyou.one";

function parseYouCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select("#list-series a[href], .list-series a[href], .cat-img a[href], .post-title a[href], #categorytitle a[href], .entry-title a[href]")) {
    const href = a.attr("href");
    if (!href || href.includes("/kategori/") || href.includes("-sezon-")) continue;
    const full = absoluteUrl(base, href);
    if (seen.has(full)) continue;
    const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
    const rawTitle = a.text() || a.attr("title") || img?.attr("alt") || "";
    const title = decodeHtmlEntities(rawTitle).replace(/\s*izle\s*$/i, "").trim();
    if (!title || title.length < 2) continue;
    seen.add(full);
    const poster = img?.attr("data-src") || img?.attr("src");
    out.push({
      nativeId: `series:${encodeURIComponent(full)}`,
      type: "series",
      title,
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return out;
}

async function resolveDiziYouEpisode(
  epUrl: string,
  base: string,
  storageUrl: string,
): Promise<StreamCandidate[]> {
  const epHtml = await fetchText(epUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!epHtml) return [];

  const doc = html.parse(epHtml);
  const playerSrc = doc.selectOne("#diziyouPlayer")?.attr("src");
  if (!playerSrc) return [];
  const itemId = playerSrc.split("/").pop()?.replace(/\.html$/i, "").split("?")[0] ?? "";
  if (!itemId) return [];

  const hasSub = epHtml.includes("turkceAltyazili");
  const hasDub = epHtml.includes("turkceDublaj");
  const headers = buildHeaders(`${base}/`);
  const subtitles: SubtitleTrack[] = [
    {
      id: "tr_0",
      source: {
        kind: "url",
        url: `${storageUrl}/subtitles/${itemId}/tr.vtt`,
        headers,
      },
      lang: "tr",
      label: "Türkçe",
      format: "vtt",
      isDefault: true,
    },
  ];

  const out: StreamCandidate[] = [];
  if (hasSub || !hasDub) {
    out.push(
      createStream({
        url: `${storageUrl}/episodes/${itemId}/play.m3u8`,
        kind: "hls",
        quality: "1080p",
        label: "DiziYou • Türkçe Altyazılı 1080p HLS",
        audioType: "sub",
        language: "en",
        headers,
        subtitles,
      }),
    );
  }
  if (hasDub) {
    out.push(
      createStream({
        url: `${storageUrl}/episodes/${itemId}_tr/play.m3u8`,
        kind: "hls",
        quality: "1080p",
        label: "DiziYou • Türkçe Dublaj 1080p HLS",
        audioType: "dub",
        language: "tr",
        headers,
        subtitles,
      }),
    );
  }
  return out;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.diziyou.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const items = rawHtml ? dedupeMediaSummaries(parseYouCards(rawHtml, base)).slice(0, 36) : [];
      return {
        sections:
          items.length > 0
            ? [{ id: "series", title: "Diziler", layout: "poster", items }]
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
      const base = await resolveBaseUrl("urls.series.diziyou.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/?s=${encodeURIComponent(query.trim())}`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      return {
        items: rawHtml ? dedupeMediaSummaries(parseYouCards(rawHtml, base)).slice(0, 30) : [],
        hasMore: false,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.diziyou.base", DEFAULT_BASE, "mirrorUrl");
    const showUrl = decodeURIComponent(nativeId.replace(/^series:/, ""));
    const rawHtml = await fetchText(showUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`DiziYou dizisi açılamadı: ${showUrl}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || "DiziYou").trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<string>();

    for (const a of doc.select('a[href*="-sezon-"][href*="-bolum"]')) {
      const href = a.attr("href");
      if (!href) continue;
      const full = absoluteUrl(base, href);
      if (seen.has(full)) continue;
      seen.add(full);
      const parsed = parseSeasonEpisode(full, 1);
      const s = parsed?.season ?? 1;
      const e = parsed?.episode ?? episodes.length + 1;
      episodes.push({
        streamId: `ep:${encodeURIComponent(full)}`,
        season: s,
        episode: e,
        title: `${s}. Sezon ${e}. Bölüm`,
      });
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const seasons: SeasonSummary[] = Array.from(new Set(episodes.map((e) => e.season))).map(
      (s) => ({
        id: String(s),
        season: s,
        title: `${s}. Sezon`,
        episodeCount: episodes.filter((e) => e.season === s).length,
      }),
    );

    return { nativeId, type: "series", title, poster, backdrop: poster, seasons, episodes };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.diziyou.base", DEFAULT_BASE, "mirrorUrl");
      const storageUrl = await resolveBaseUrl(
        "urls.series.diziyou.storage",
        DEFAULT_STORAGE,
      );

      if (streamId.startsWith("ep:")) {
        return finalizeStreams(
          await resolveDiziYouEpisode(decodeURIComponent(streamId.slice(3)), base, storageUrl),
        );
      }

      const parts = streamId.split(":");
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, "series");
      if (!identity) return { streams: [] };
      const sTarget = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      for (const q of [identity.title, identity.originalTitle].filter(Boolean)) {
        const sHtml = await fetchText(`${base}/?s=${encodeURIComponent(q)}`, {
          timeoutMs: 10_000,
          headers: buildHeaders(`${base}/`),
        });
        if (!sHtml) continue;
        const cands = parseYouCards(sHtml, base).map((c) => ({
          title: c.title,
          url: decodeURIComponent(c.nativeId.replace(/^series:/, "")),
        }));
        const best = pickBestCandidate(cands, identity.title, identity.originalTitle);
        if (!best) continue;

        const slug = best.url.split("/").filter(Boolean).pop() ?? "";
        const baseSlug = slug.replace(/\d+$/, "");
        const urlsToTry = [
          `${base}/${slug}-${sTarget}-sezon-${eTarget}-bolum/`,
          ...(baseSlug && baseSlug !== slug
            ? [`${base}/${baseSlug}-${sTarget}-sezon-${eTarget}-bolum/`]
            : []),
        ];
        for (const u of urlsToTry) {
          const streams = await resolveDiziYouEpisode(u, base, storageUrl);
          if (streams.length > 0) return finalizeStreams(streams);
        }

        const detail = await this.getDetails!(`series:${encodeURIComponent(best.url)}`);
        const ep = detail.episodes.find((x) => x.season === sTarget && x.episode === eTarget);
        if (ep) {
          return finalizeStreams(
            await resolveDiziYouEpisode(decodeURIComponent(ep.streamId.slice(3)), base, storageUrl),
          );
        }
      }
      return { streams: [] };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
