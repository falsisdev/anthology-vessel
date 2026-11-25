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
import { resolveTmdbIdentity, tmdbSearch } from "./shared/core/tmdb.ts";
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
  const tasks: Array<Promise<StreamCandidate[]>> = [];
  while ((vm = vmRe.exec(epHtml)) !== null) {
    const vidId = vm[1];
    if (!vidId || seenIds.has(vidId)) continue;
    seenIds.add(vidId);
    tasks.push(
      extractVidmoly(`https://vidmoly.to/embed-${vidId}.html`, {
        sourceLabel: "YabancıDizi",
        referer: `${base}/`,
      }),
    );
  }
  if (tasks.length > 0) {
    streams.push(...(await Promise.all(tasks)).flat());
  }

  return streams;
}

function cleanPosterUrl(raw: string | undefined | null, base: string): string | undefined {
  const val = raw?.trim();
  if (!val || val.startsWith("data:")) return undefined;
  const firstSrc = val.split(",")[0]?.trim().split(/\s+/)[0]?.trim();
  if (!firstSrc || firstSrc.startsWith("data:")) return undefined;
  if (firstSrc.startsWith("/") || /^https?:\/\//i.test(firstSrc) || firstSrc.startsWith("//")) {
    return absoluteUrl(base, firstSrc);
  }
  return `${base.replace(/\/+$/, "")}/${firstSrc.replace(/^\/+/, "")}`;
}

function extractCardPoster(el: ReturnType<ReturnType<typeof html.parse>["select"]>[number], base: string): string | undefined {
  const nodes = [el, el.parent(), el.parent()?.parent()].filter(
    (n): n is NonNullable<typeof n> => Boolean(n),
  );
  for (const node of nodes) {
    for (const img of node.select("img, source")) {
      const candidate =
        img.attr("data-src") ||
        img.attr("data-lazy") ||
        img.attr("data-original") ||
        img.attr("data-ll-src") ||
        img.attr("data-srcset") ||
        img.attr("srcset") ||
        img.attr("src");
      const cleaned = cleanPosterUrl(candidate, base);
      if (cleaned) return cleaned;
    }
    for (const bgEl of [node, ...node.select("[data-bg], [style*='background']")]) {
      const bgAttr = bgEl.attr("data-bg") || bgEl.attr("data-background");
      const bgStyle = bgEl.attr("style") ?? "";
      const styleUrl = /url\(['"]?([^'")]+)['"]?\)/i.exec(bgStyle)?.[1];
      const cleaned = cleanPosterUrl(bgAttr || styleUrl, base);
      if (cleaned) return cleaned;
    }
  }
  const rawHtml = el.html();
  const uploadMatch = /(?:uploads\/series\/|image\.tmdb\.org\/t\/p\/)[^"'\s<>)]+/i.exec(rawHtml)?.[0];
  return cleanPosterUrl(uploadMatch, base);
}

async function lookupYdSitePoster(title: string, base: string): Promise<string | undefined> {
  const res = await postForm(
    `${base}/search?qr=${encodeURIComponent(title)}`,
    {},
    {
      timeoutMs: 4_500,
      headers: { Referer: `${base}/`, "X-Requested-With": "XMLHttpRequest" },
    },
  );
  if (!res || res.status >= 400) return undefined;
  try {
    const data = res.json<{ data?: { result?: YdSearchResult[] } }>();
    const hit = (data.data?.result ?? []).find((r) => Boolean(r.s_image));
    if (!hit?.s_image) return undefined;
    return hit.s_image.startsWith("http")
      ? hit.s_image
      : `${base}/uploads/series/${hit.s_image.replace(/^\/+/, "")}`;
  } catch {
    return undefined;
  }
}

async function hydrateYdPosters(items: MediaSummary[], base: string, limit = 24): Promise<void> {
  const missing = items.filter((it) => !it.poster).slice(0, limit);
  const BATCH = 6;
  for (let i = 0; i < missing.length; i += BATCH) {
    await Promise.all(
      missing.slice(i, i + BATCH).map(async (item) => {
        const sitePoster = await lookupYdSitePoster(item.title, base);
        if (sitePoster) {
          item.poster = sitePoster;
          return;
        }
        const tmdbHits = await tmdbSearch({
          idPrefix: "yabancidizi",
          query: item.title,
          mediaType: item.type === "movie" ? "movie" : "series",
          page: 1,
        });
        const bestPoster = tmdbHits.items.find((x) => Boolean(x.poster))?.poster;
        if (bestPoster) item.poster = bestPoster;
      }),
    );
  }
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

      for (const box of doc.select(".poster, .poster-media, .poster-long, .poster-xs, .segment-poster-sm, article")) {
        const a = box.selectOne('a[href*="dizi/"]');
        const href = a?.attr("href");
        if (!href || href.includes("/tur/")) continue;
        const slugMatch = /(?:^|\/)dizi\/([^/?#]+)/.exec(href);
        const slug = slugMatch?.[1]?.trim() ?? "";
        if (!slug || seen.has(slug)) continue;
        const img = box.selectOne("img");
        const rawTitle =
          box.selectOne("h2, h3, .truncate")?.text() ||
          a?.attr("title") ||
          img?.attr("alt") ||
          a?.text() ||
          "";
        const title = decodeHtmlEntities(rawTitle)
          .replace(/\s+izle$/i, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!title || title.length < 2) continue;
        seen.add(slug);
        items.push({
          nativeId: `series:${slug}`,
          type: "series",
          title,
          poster: extractCardPoster(box, base),
        });
      }

      if (items.length === 0) {
        for (const a of doc.select('a[href*="dizi/"]')) {
          const href = a.attr("href");
          if (!href || href.includes("/tur/")) continue;
          const slugMatch = /(?:^|\/)dizi\/([^/?#]+)/.exec(href);
          const slug = slugMatch?.[1]?.trim() ?? "";
          const title = decodeHtmlEntities(a.attr("title") || a.text())
            .replace(/\s+izle$/i, "")
            .replace(/\s+/g, " ")
            .trim();
          if (!slug || seen.has(slug) || title.length < 2) continue;
          seen.add(slug);
          items.push({
            nativeId: `series:${slug}`,
            type: "series",
            title,
            poster: extractCardPoster(a, base),
          });
        }
      }

      const top = dedupeMediaSummaries(items).slice(0, 36);
      await hydrateYdPosters(top, base, 24);
      return {
        sections:
          top.length > 0
            ? [
                {
                  id: "popular",
                  title: "Popüler Yabancı Diziler",
                  layout: "poster",
                  items: top,
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
    const profileImg = doc.selectOne("img.series-profile-thumb, .series-profile-image img, img[src*='uploads/series'], img[data-src*='uploads/series']");
    const ogImg = doc.selectOne('meta[property="og:image"]')?.attr("content");
    let poster =
      cleanPosterUrl(
        profileImg?.attr("data-src") || profileImg?.attr("data-lazy") || profileImg?.attr("src"),
        base,
      ) ??
      cleanPosterUrl(ogImg, base);
    if (!poster) {
      poster =
        (await lookupYdSitePoster(title, base)) ??
        (await resolveTmdbIdentity(title, isMovie ? "movie" : "series"))?.poster;
    }
    const backdrop = cleanPosterUrl(ogImg, base) ?? poster;
    if (isMovie) {
      return {
        nativeId,
        type: "movie",
        title,
        poster,
        backdrop,
        episodes: [{ streamId: `ep:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title }],
      };
    }

    const episodes: Episode[] = [];
    const seen = new Set<string>();
    for (const a of doc.select('a[href*="/sezon-"][href*="/bolum-"], a[href*="sezon-"][href*="bolum-"]')) {
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

    return { nativeId, type: "series", title, poster, backdrop, seasons, episodes };
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
