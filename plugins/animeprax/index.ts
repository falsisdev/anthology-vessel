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
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import { absoluteUrl, decodeHtmlEntities } from "./shared/core/text.ts";
import { resolveTmdbIdentity, tmdbBuildMediaDetail, tmdbSearch } from "./shared/core/tmdb.ts";
import {
  collectAnimeSearchTitles,
  discoverPopularAnime,
  resolveDiziWatchAnimeFallback,
} from "./shared/core/anime-helpers.ts";
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://animeprax.com";

interface AnimePraxSearchItem {
  slug?: string;
  title?: string;
  cover_image_url?: string;
}

async function searchPraxNative(query: string, base: string): Promise<MediaSummary[] | null> {
  const list = await fetchJson<AnimePraxSearchItem[]>(
    `${base}/api/search?q=${encodeURIComponent(query)}`,
    {
      timeoutMs: 2_500,
      headers: { ...buildHeaders(`${base}/`), Accept: "application/json" },
    },
  );
  if (!list) return null;
  return list
    .filter((it) => Boolean(it.slug))
    .map<MediaSummary>((it) => ({
      nativeId: `anime:${it.slug!}`,
      type: "series",
      isAnime: true,
      title: decodeHtmlEntities(it.title || it.slug!).trim(),
      poster: it.cover_image_url ? absoluteUrl(base, it.cover_image_url) : undefined,
    }));
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.anime.animeprax.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 2_000,
        headers: buildHeaders(`${base}/`),
      });

      const items: MediaSummary[] = [];
      const seen = new Set<string>();
      if (rawHtml) {
        const doc = html.parse(rawHtml);
        for (const card of doc.select("article.anime-card")) {
          const a = card.selectOne('a[href*="/anime/"]');
          const href = a?.attr("href");
          const slug = href ? /\/anime\/([a-z0-9-]+)/i.exec(href)?.[1] : undefined;
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);
          const img = card.selectOne("img");
          const title = decodeHtmlEntities(img?.attr("alt") || a?.text() || slug).trim();
          const poster = img?.attr("src");
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
        items.push(...(await discoverPopularAnime("animeprax")));
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
      const base = await resolveBaseUrl("urls.anime.animeprax.base", DEFAULT_BASE, "mirrorUrl");
      const hits = await searchPraxNative(query.trim(), base);
      if (hits && hits.length > 0) return { items: hits, hasMore: false };

      return tmdbSearch({
        idPrefix: "animeprax",
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
    if (nativeId.startsWith("animeprax:series:") || nativeId.startsWith("animeprax:movie:")) {
      const det = await tmdbBuildMediaDetail({
        nativeId,
        preferType: "series",
        isAnime: true,
        streamIdBuilder: (identity, s, e) => `tmdb:${identity.tmdbId}:${s}:${e}`,
      });
      if (det) return det;
    }

    const base = await resolveBaseUrl("urls.anime.animeprax.base", DEFAULT_BASE, "mirrorUrl");
    const slug = nativeId.replace(/^anime:/, "");
    const rawHtml = await fetchText(`${base}/anime/${slug}`, {
      timeoutMs: 6_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`AnimePraX içeriği açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne(".anime-title, h1")?.text() || slug,
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<string>();

    for (const a of doc.select('a.episode-card[href*="/season/"]')) {
      const href = a.attr("href");
      const m = href ? /season\/(\d+)\/episode\/(\d+)/.exec(href) : null;
      if (!m?.[1] || !m?.[2]) continue;
      const key = `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = Number.parseInt(m[1], 10);
      const e = Number.parseInt(m[2], 10);
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
      const base = await resolveBaseUrl("urls.anime.animeprax.base", DEFAULT_BASE, "mirrorUrl");
      let slug = "";
      let sNum = 1;
      let eNum = 1;
      let fallbackTitles: string[] = [];

      if (streamId.startsWith("ep:") || streamId.startsWith("anime:")) {
        const parts = streamId.split(":");
        slug = parts[1] ?? "";
        sNum = Number.parseInt(parts[2] ?? "1", 10) || 1;
        eNum = Number.parseInt(parts[3] ?? "1", 10) || 1;
        fallbackTitles = [slug.replace(/-/g, " ")];
      } else {
        const parts = streamId.split(":");
        const idToken =
          streamId.startsWith("tmdb:") || streamId.startsWith("animeprax:")
            ? parts[1] ?? streamId
            : parts[0] ?? streamId;
        const offset =
          streamId.startsWith("tmdb:") || streamId.startsWith("animeprax:") ? 2 : 1;
        sNum = Number.parseInt(parts[offset] ?? "1", 10) || 1;
        eNum = Number.parseInt(parts[offset + 1] ?? "1", 10) || 1;

        const identity = await resolveTmdbIdentity(idToken, "series");
        if (identity) {
          fallbackTitles = collectAnimeSearchTitles(identity);
          for (const q of fallbackTitles.slice(0, 2)) {
            const hits = await searchPraxNative(q, base);
            if (hits === null) break;
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
        const epPageUrl = `${base}/anime/${slug}/season/${sNum}/episode/${eNum}`;
        const epHtml = await fetchText(epPageUrl, {
          timeoutMs: 3_500,
          headers: buildHeaders(`${base}/`),
        });
        if (epHtml) {
          const teamIds = Array.from(
            new Set(
              Array.from(epHtml.matchAll(/data-team-id="(\d+)"/g)).map((m) => m[1]!),
            ),
          );
          const teamResponses = await Promise.all(
            teamIds.slice(0, 3).map((teamId) =>
              fetchJson<{ sources?: Array<{ url?: string; embed_url?: string }> }>(
                `${base}/anime/${slug}/season/${sNum}/episode/${eNum}/sources?team=${encodeURIComponent(teamId)}`,
                {
                  timeoutMs: 3_500,
                  headers: {
                    ...buildHeaders(epPageUrl),
                    "X-Requested-With": "XMLHttpRequest",
                  },
                },
              ),
            ),
          );
          const embedUrls: string[] = [];
          for (const res of teamResponses) {
            for (const src of res?.sources ?? []) {
              const target = src.embed_url ?? src.url;
              if (target) embedUrls.push(absoluteUrl(base, target));
            }
          }
          if (embedUrls.length > 0) {
            const resolved = await Promise.all(
              embedUrls.slice(0, 6).map((u) =>
                extractByEmbedUrl(u, {
                  sourceLabel: "AnimePraX",
                  audioType: "sub",
                  language: "ja",
                  referer: epPageUrl,
                }),
              ),
            );
            out.push(...resolved.flat());
          }
        }
      }

      if (out.length === 0 && fallbackTitles.length > 0) {
        out.push(
          ...(await resolveDiziWatchAnimeFallback(fallbackTitles, sNum, eNum, "AnimePraX")),
        );
      }
      return finalizeStreams(out);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
