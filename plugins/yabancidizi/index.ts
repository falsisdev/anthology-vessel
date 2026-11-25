import { definePlugin, html } from "vessel";
import type {
  AudioType,
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
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractVidmoly } from "./shared/extractors/vidmoly.ts";

const DEFAULT_BASE = "https://yabancidizi.news";

interface YdSearchResult {
  s_name?: string;
  s_link?: string;
  s_type?: string;
  s_year?: string;
  s_image?: string;
}

async function resolveYdEpisode(
  epUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const epHtml = await fetchText(epUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!epHtml) return [];

  const streams: StreamCandidate[] = [];
  const seenIds = new Set<string>();

  const dlRe =
    /<a[^>]+href=["'](https?:\/\/vidmoly\.[a-z0-9]+\/dl\/([a-zA-Z0-9_-]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = dlRe.exec(epHtml)) !== null) {
    const vidId = m[2];
    const labelText = (m[3] ?? "").replace(/<[^>]+>/g, "").trim();
    if (!vidId || seenIds.has(vidId)) continue;
    seenIds.add(vidId);
    const audioType: AudioType = /dublaj/i.test(labelText) ? "dub" : "sub";
    streams.push(
      ...(await extractVidmoly(`https://vidmoly.biz/embed-${vidId}.html`, {
        sourceLabel: "YabancıDizi",
        audioType,
        referer: `${base}/`,
      })),
    );
  }

  const vmRe = /vidmoly\.[a-z0-9]+\/(?:dl\/|embed-)([a-zA-Z0-9_-]+)/gi;
  let vm: RegExpExecArray | null;
  while ((vm = vmRe.exec(epHtml)) !== null) {
    const vidId = vm[1];
    if (!vidId || seenIds.has(vidId)) continue;
    seenIds.add(vidId);
    streams.push(
      ...(await extractVidmoly(`https://vidmoly.biz/embed-${vidId}.html`, {
        sourceLabel: "YabancıDizi",
        referer: `${base}/`,
      })),
    );
  }

  return streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.yabancidizi.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      if (!rawHtml) return { sections: [] };

      const doc = html.parse(rawHtml);
      const items: MediaSummary[] = [];
      const seen = new Set<string>();
      for (const a of doc.select('a[href*="/dizi/"]')) {
        const href = a.attr("href");
        if (!href || href.includes("/tur/") || href.includes("/sezon-")) continue;
        const slug = href.split("/dizi/")[1]?.split("/")[0]?.trim() ?? "";
        const title = decodeHtmlEntities(a.text()).replace(/\s+/g, " ").trim();
        if (!slug || seen.has(slug) || title.length < 2) continue;
        seen.add(slug);
        const img = a.selectOne("img");
        const poster = img?.attr("data-src") || img?.attr("src");
        items.push({
          nativeId: `series:${slug}`,
          type: "series",
          title,
          poster: poster ? absoluteUrl(base, poster) : undefined,
        });
      }
      return {
        sections:
          items.length > 0
            ? [
                {
                  id: "popular",
                  title: "Popüler Yabancı Diziler",
                  layout: "poster",
                  items: dedupeMediaSummaries(items).slice(0, 36),
                },
              ]
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
      const base = await resolveBaseUrl("urls.series.yabancidizi.base", DEFAULT_BASE, "mirrorUrl");
      const res = await postForm(
        `${base}/search?qr=${encodeURIComponent(query.trim())}`,
        {},
        {
          timeoutMs: 8_000,
          headers: { Referer: `${base}/`, "X-Requested-With": "XMLHttpRequest" },
        },
      );
      if (!res || res.status >= 400) return { items: [], hasMore: false };

      let rows: YdSearchResult[] = [];
      try {
        const data = res.json<{ data?: { result?: YdSearchResult[] } }>();
        rows = data.data?.result ?? [];
      } catch {
        return { items: [], hasMore: false };
      }

      const items: MediaSummary[] = rows
        .filter((r) => Boolean(r.s_link && r.s_name))
        .map((r) => {
          const isMovie = r.s_type === "1";
          const poster = r.s_image
            ? r.s_image.startsWith("http")
              ? r.s_image
              : `${base}/uploads/series/${r.s_image}`
            : undefined;
          return {
            nativeId: `${isMovie ? "movie" : "series"}:${r.s_link!}`,
            type: isMovie ? "movie" : "series",
            title: decodeHtmlEntities(r.s_name!).trim(),
            year: extractYear(r.s_year),
            poster,
          };
        });
      return { items, hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.yabancidizi.base", DEFAULT_BASE, "mirrorUrl");
    const isMovie = nativeId.startsWith("movie:");
    const slug = nativeId.replace(/^(?:movie|series):/, "");
    const pageUrl = isMovie ? `${base}/film/${slug}` : `${base}/dizi/${slug}`;
    const rawHtml = await fetchText(pageUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`YabancıDizi içeriği açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || slug).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    if (isMovie) {
      return {
        nativeId,
        type: "movie",
        title,
        poster,
        backdrop: poster,
        episodes: [{ streamId: `ep:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title }],
      };
    }

    const episodes: Episode[] = [];
    const seen = new Set<string>();
    for (const a of doc.select('a[href*="/sezon-"][href*="/bolum-"]')) {
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
      const base = await resolveBaseUrl("urls.series.yabancidizi.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("ep:")) {
        return finalizeStreams(await resolveYdEpisode(decodeURIComponent(streamId.slice(3)), base));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };
      const sTarget = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      for (const q of [identity.title, identity.originalTitle].filter(Boolean)) {
        const sr = await this.search!(q, {}, 1);
        if (sr.items.length === 0) continue;
        const best = pickBestCandidate(
          sr.items.map((x) => ({ title: x.title, year: x.year, nativeId: x.nativeId })),
          identity.title,
          identity.originalTitle,
          identity.year,
        );
        if (!best) continue;
        const slug = best.nativeId.replace(/^(?:movie|series):/, "");
        const targetUrl =
          best.nativeId.startsWith("movie:")
            ? `${base}/film/${slug}`
            : `${base}/dizi/${slug}/sezon-${sTarget}/bolum-${eTarget}`;
        const streams = await resolveYdEpisode(targetUrl, base);
        if (streams.length > 0) return finalizeStreams(streams);
      }

      return { streams: [] };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
