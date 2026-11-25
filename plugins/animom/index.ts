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
  postForm,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import {
  extractUniqueFrameUrls,
  finalizeStreams,
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import { absoluteUrl, decodeHtmlEntities, parseSeasonEpisode } from "./shared/core/text.ts";
import { resolveTmdbIdentity, tmdbBuildMediaDetail, tmdbSearch } from "./shared/core/tmdb.ts";
import {
  collectAnimeSearchTitles,
  discoverPopularAnime,
  resolveDiziWatchAnimeFallback,
} from "./shared/core/anime-helpers.ts";
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://animom.org";

async function searchAniMomNative(query: string, base: string): Promise<MediaSummary[] | null> {
  const res = await postForm(
    `${base}/search`,
    { query },
    {
      timeoutMs: 2_500,
      headers: {
        ...buildHeaders(`${base}/`),
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!res || res.status < 200 || res.status >= 300) return null;
  try {
    const data = res.json<{ success?: boolean; theme?: string }>();
    if (!data.success || !data.theme) return [];
    const doc = html.parse(data.theme);
    const items: MediaSummary[] = [];
    const seen = new Set<string>();
    for (const a of doc.select('a[href*="/anime/"]')) {
      const href = a.attr("href");
      if (!href) continue;
      const slug = /\/anime\/([^/?#]+)/.exec(href)?.[1];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const img = a.selectOne("img");
      const title = decodeHtmlEntities(img?.attr("alt") || a.text() || slug).trim();
      const poster = img?.attr("data-src") || img?.attr("src");
      items.push({
        nativeId: `anime:${slug}`,
        type: "series",
        isAnime: true,
        title,
        poster: poster ? absoluteUrl(base, poster) : undefined,
      });
    }
    return items;
  } catch {
    return [];
  }
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.anime.animom.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/home`, {
        timeoutMs: 2_500,
        headers: buildHeaders(`${base}/`),
      });

      const items: MediaSummary[] = [];
      const seen = new Set<string>();
      if (rawHtml) {
        const doc = html.parse(rawHtml);
        for (const a of doc.select('a.block[href*="/anime/"], a[href*="/anime/"]')) {
          const href = a.attr("href");
          const slug = href ? /\/anime\/([^/?#]+)/.exec(href)?.[1] : undefined;
          if (!slug || seen.has(slug)) continue;
          const img = a.selectOne("img");
          const title = decodeHtmlEntities(img?.attr("alt") || a.text() || slug).trim();
          if (!title) continue;
          seen.add(slug);
          const poster = img?.attr("data-src") || img?.attr("src");
          items.push({
            nativeId: `anime:${slug}`,
            type: "series",
            isAnime: true,
            title,
            poster: poster ? absoluteUrl(base, poster) : undefined,
          });
          if (items.length >= 30) break;
        }
      }

      if (items.length === 0) {
        items.push(...(await discoverPopularAnime("animom")));
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
      const base = await resolveBaseUrl("urls.anime.animom.base", DEFAULT_BASE, "mirrorUrl");
      const hits = await searchAniMomNative(query.trim(), base);
      if (hits && hits.length > 0) return { items: hits, hasMore: false };

      return tmdbSearch({
        idPrefix: "animom",
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
    if (nativeId.startsWith("animom:series:") || nativeId.startsWith("animom:movie:")) {
      const det = await tmdbBuildMediaDetail({
        nativeId,
        preferType: "series",
        isAnime: true,
        streamIdBuilder: (identity, s, e) => `tmdb:${identity.tmdbId}:${s}:${e}`,
      });
      if (det) return det;
    }

    const base = await resolveBaseUrl("urls.anime.animom.base", DEFAULT_BASE, "mirrorUrl");
    const slug = nativeId.replace(/^anime:/, "");
    const rawHtml = await fetchText(`${base}/anime/${slug}`, {
      timeoutMs: 6_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`AniMOM içeriği açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || slug).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<string>();

    for (const a of doc.select(`a[href*="/anime/${slug}/"]`)) {
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
      const base = await resolveBaseUrl("urls.anime.animom.base", DEFAULT_BASE, "mirrorUrl");
      let fallbackTitles: string[] = [];
      let sNum = 1;
      let eNum = 1;
      let targetUrl = "";

      if (streamId.startsWith("ep:")) {
        targetUrl = decodeURIComponent(streamId.slice(3));
        const parsed = parseSeasonEpisode(targetUrl, 1);
        sNum = parsed?.season ?? 1;
        eNum = parsed?.episode ?? 1;
      } else if (streamId.startsWith("anime:")) {
        const det = await this.getDetails!(streamId);
        const ep = det.episodes[0];
        if (ep?.streamId.startsWith("ep:")) {
          targetUrl = decodeURIComponent(ep.streamId.slice(3));
        }
        fallbackTitles = [det.title];
      } else {
        const parts = streamId.split(":");
        const idToken =
          streamId.startsWith("tmdb:") || streamId.startsWith("animom:")
            ? parts[1] ?? streamId
            : parts[0] ?? streamId;
        const offset = streamId.startsWith("tmdb:") || streamId.startsWith("animom:") ? 2 : 1;
        sNum = Number.parseInt(parts[offset] ?? "1", 10) || 1;
        eNum = Number.parseInt(parts[offset + 1] ?? "1", 10) || 1;

        const identity = await resolveTmdbIdentity(idToken, "series");
        if (identity) {
          fallbackTitles = collectAnimeSearchTitles(identity);
          for (const q of fallbackTitles.slice(0, 2)) {
            const hits = await searchAniMomNative(q, base);
            if (hits === null) break;
            const best = pickBestCandidate(
              hits.map((x) => ({ title: x.title, nativeId: x.nativeId })),
              identity.title,
              identity.originalTitle,
            );
            if (best) {
              const slug = best.nativeId.replace(/^anime:/, "");
              targetUrl = `${base}/anime/${slug}/sezon-${sNum}/bolum-${eNum}`;
              break;
            }
          }
        }
      }

      const out: StreamCandidate[] = [];
      if (targetUrl) {
        const epHtml = await fetchText(targetUrl, {
          timeoutMs: 6_000,
          headers: buildHeaders(`${base}/`),
        });
        if (epHtml) {
          for (const frameUrl of extractUniqueFrameUrls(epHtml, base)) {
            out.push(
              ...(await extractByEmbedUrl(frameUrl, {
                sourceLabel: "AniMOM",
                audioType: "sub",
                language: "ja",
                referer: targetUrl,
              })),
            );
          }
        }
      }

      if (out.length === 0 && fallbackTitles.length > 0) {
        out.push(...(await resolveDiziWatchAnimeFallback(fallbackTitles, sNum, eNum, "AniMOM")));
      }
      return finalizeStreams(out);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
