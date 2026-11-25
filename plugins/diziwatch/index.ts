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
  fetchJson,
  fetchText,
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
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import {
  extractAnizmPlayer,
  extractByEmbedUrl,
} from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://diziwatch.org";

interface DiziWatchApiItem {
  used_slug?: string;
  slug?: string;
  object_name?: string;
  title?: string;
  poster?: string;
  image?: string;
}

function parseWatchCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select('a[href*="/dizi/"], a[href*="/anime/"]')) {
    const href = a.attr("href");
    if (!href || href.includes("/sezon-") || href.includes("/bolum-")) continue;
    const full = absoluteUrl(base, href).replace(/\/+$/, "");
    const slug = full.split("/").pop() ?? "";
    if (!slug || seen.has(slug)) continue;
    const img = a.selectOne("img");
    const rawTitle = a.selectOne("h2, h3, .title")?.text() || img?.attr("alt") || a.text();
    const title = decodeHtmlEntities(rawTitle).trim();
    if (!title || title.length < 2) continue;
    seen.add(slug);
    const isAnime = full.includes("/anime/");
    const poster = img?.attr("data-src") || img?.attr("src");
    out.push({
      nativeId: `series:${slug}`,
      type: "series",
      isAnime,
      title,
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return out;
}

async function resolveWatchEpisode(
  slug: string,
  season: number,
  episode: number,
  base: string,
): Promise<StreamCandidate[]> {
  const cleanSlug = slug.replace(/^\/+|dizi\//g, "");
  const epUrl = `${base}/dizi/${cleanSlug}/sezon-${season}/bolum-${episode}`;
  const epHtml = await fetchText(epUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!epHtml) return [];

  const tasks: Array<Promise<StreamCandidate[]>> = [];
  const seenHashes = new Set<string>();
  const apRe = /https?:\/\/anizmplayer\.com\/video\/([a-f0-9]{16,64})/gi;
  let m: RegExpExecArray | null;
  while ((m = apRe.exec(epHtml)) !== null) {
    const hash = m[1];
    if (!hash || seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    tasks.push(
      extractAnizmPlayer(hash, {
        sourceLabel: "DiziWatch",
        referer: epUrl,
      }),
    );
  }

  const okRe = /https?:\/\/ok\.ru\/videoembed\/\d+/gi;
  const seenOk = new Set<string>();
  let om: RegExpExecArray | null;
  while ((om = okRe.exec(epHtml)) !== null) {
    if (seenOk.has(om[0])) continue;
    seenOk.add(om[0]);
    tasks.push(
      extractByEmbedUrl(om[0], {
        sourceLabel: "DiziWatch",
        referer: epUrl,
      }),
    );
  }

  const sibRe = /https?:\/\/video\.sibnet\.ru\/[^\s"'<>\\]+/gi;
  const seenSib = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = sibRe.exec(epHtml)) !== null) {
    if (seenSib.has(sm[0])) continue;
    seenSib.add(sm[0]);
    tasks.push(
      extractByEmbedUrl(sm[0], {
        sourceLabel: "DiziWatch",
        referer: epUrl,
      }),
    );
  }

  if (tasks.length === 0) return [];
  return (await Promise.all(tasks)).flat();
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.diziwatch.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const items = rawHtml ? dedupeMediaSummaries(parseWatchCards(rawHtml, base)).slice(0, 36) : [];
      return {
        sections:
          items.length > 0
            ? [{ id: "latest", title: "Diziler & Animeler", layout: "poster", items }]
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
      const base = await resolveBaseUrl("urls.series.diziwatch.base", DEFAULT_BASE, "mirrorUrl");
      const data = await fetchJson<DiziWatchApiItem[] | { results?: DiziWatchApiItem[] }>(
        `${base}/api/ara?q=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
      );
      const list = Array.isArray(data) ? data : data?.results ?? [];
      const items: MediaSummary[] = list
        .filter((it) => it.used_slug || it.slug)
        .map((it) => ({
          nativeId: `series:${it.used_slug || it.slug!}`,
          type: "series",
          title: decodeHtmlEntities(it.object_name || it.title || it.used_slug || "").trim(),
          poster: it.poster || it.image || undefined,
        }));
      return { items: dedupeMediaSummaries(items), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.diziwatch.base", DEFAULT_BASE, "mirrorUrl");
    const slug = nativeId.replace(/^series:/, "");
    const rawHtml = await fetchText(`${base}/dizi/${slug}`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`DiziWatch içeriği açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || slug).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<string>();

    for (const a of doc.select('a[href*="/sezon-"][href*="/bolum-"]')) {
      const href = a.attr("href");
      if (!href) continue;
      const parsed = parseSeasonEpisode(href, 1);
      const s = parsed?.season ?? 1;
      const e = parsed?.episode ?? episodes.length + 1;
      const key = `${s}:${e}`;
      if (seen.has(key)) continue;
      seen.add(key);
      episodes.push({
        streamId: `ep:${slug}:${s}:${e}`,
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
      const base = await resolveBaseUrl("urls.series.diziwatch.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("ep:")) {
        const parts = streamId.split(":");
        const slug = parts[1] ?? "";
        const s = Number.parseInt(parts[2] ?? "1", 10) || 1;
        const e = Number.parseInt(parts[3] ?? "1", 10) || 1;
        return finalizeStreams(await resolveWatchEpisode(slug, s, e, base));
      }

      const parts = streamId.split(":");
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, "series");
      if (!identity) return { streams: [] };
      const sTarget = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      for (const q of [identity.title, identity.originalTitle].filter(Boolean)) {
        const sr = await this.search!(q, {}, 1);
        if (sr.items.length === 0) continue;
        const best = pickBestCandidate(
          sr.items.map((x) => ({ title: x.title, slug: x.nativeId.replace(/^series:/, "") })),
          identity.title,
          identity.originalTitle,
        );
        if (best) {
          const streams = await resolveWatchEpisode(best.slug, sTarget, eTarget, base);
          if (streams.length > 0) return finalizeStreams(streams);
        }
      }
      return { streams: [] };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
