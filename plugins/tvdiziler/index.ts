import { definePlugin, html } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
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
import { createStream, inferStreamKind } from "./shared/core/quality.ts";
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

const DEFAULT_BASE = "https://tvdiziler.tv";

function parseTvDizilerCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select('a[href*="dizi/"]')) {
    const href = a.attr("href");
    if (!href) continue;
    const rel = href.startsWith("http")
      ? new URL(href).pathname.replace(/^\/+/, "")
      : href.replace(/^\/+/, "");
    if (!rel.startsWith("dizi/") || seen.has(rel)) continue;
    const title = decodeHtmlEntities(
      a.selectOne("h2, h3")?.text() || a.text(),
    )
      .replace(/\s*izle\s*(?:\(\d{4}\))?\s*$/i, "")
      .replace(/\s*\(\d{4}\)\s*$/i, "")
      .trim();
    if (!title) continue;
    seen.add(rel);
    const img = a.selectOne("img");
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `series:${encodeURIComponent(rel)}`,
      type: "series",
      title,
      poster: posterRaw ? absoluteUrl(base, posterRaw) : undefined,
    });
  }
  return items;
}

async function resolveTvDizilerEpisode(
  epUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const epHtml = await fetchText(epUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!epHtml) return [];

  const streams: StreamCandidate[] = [];
  const seen = new Set<string>();
  const doc = html.parse(epHtml);

  for (const btn of doc.select("[data-hhs], [data-hs]")) {
    const rawAttr = btn.attr("data-hhs") || btn.attr("data-hs") || "";
    const label = btn.text().trim() || "Tek Parça";
    for (const part of rawAttr.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (part.includes("/vid/ply/")) {
        const plyUrl = absoluteUrl(base, part);
        const plyHtml = await fetchText(plyUrl, {
          timeoutMs: 8_000,
          headers: buildHeaders(epUrl),
        });
        const srcMatch = plyHtml
          ? /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i.exec(plyHtml) ??
            /file\s*:\s*["']([^"']+)["']/i.exec(plyHtml)
          : null;
        if (srcMatch?.[1]) {
          const streamUrl = srcMatch[1].replace(/\\\//g, "/");
          if (seen.has(streamUrl)) continue;
          seen.add(streamUrl);
          const kind = inferStreamKind(streamUrl);
          const hdrs = streamUrl.includes("twimg.com")
            ? { ...buildHeaders("https://twitter.com/"), Origin: "https://twitter.com" }
            : streamUrl.includes("ciner.com.tr")
              ? buildHeaders("https://www.ciner.com.tr/")
              : buildHeaders(`${base}/`);
          streams.push(
            createStream({
              url: streamUrl,
              kind,
              quality: "1080p",
              label: `TvDiziler • ${label} (${kind.toUpperCase()})`,
              language: "tr",
              headers: hdrs,
            }),
          );
        }
      } else {
        const ytId = /[?&](?:id|v)=([a-zA-Z0-9_-]{11})/.exec(part)?.[1] ?? part;
        const yt = await resolveYouTubeInnertube(ytId, "TvDiziler");
        if (yt) streams.push(...yt.streams);
      }
    }
  }

  for (const ifr of doc.select("iframe[src]")) {
    const src = ifr.attr("src");
    if (!src) continue;
    if (src.includes("youtube") || src.includes("youtu.be")) {
      const yt = await resolveYouTubeInnertube(absoluteUrl(base, src), "TvDiziler");
      if (yt) streams.push(...yt.streams);
    }
  }
  return streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.tvdiziler.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/dizi-izle`, {
        timeoutMs: 6_000,
        headers: buildHeaders(`${base}/`),
      });
      let items = rawHtml ? parseTvDizilerCards(rawHtml, base) : [];
      if (items.length === 0) {
        items = await tmdbDiscoverFeed({
          idPrefix: "tvdiziler",
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
      const base = await resolveBaseUrl("urls.series.tvdiziler.base", DEFAULT_BASE, "mirrorUrl");
      const searchUrl = `${base}/search?qr=${encodeURIComponent(query.trim())}`;
      const res = await postForm(searchUrl, {}, {
        timeoutMs: 6_000,
        headers: { Referer: `${base}/`, "X-Requested-With": "XMLHttpRequest" },
      });
      if (res && res.status >= 200 && res.status < 300) {
        try {
          const json = res.json<{ data?: string }>();
          if (json.data) {
            return { items: parseTvDizilerCards(json.data, base), hasMore: false };
          }
        } catch {
          // Fall through
        }
      }
      return { items: [], hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    if (nativeId.startsWith("tvdiziler:series:")) {
      const identity = await resolveTmdbIdentity(nativeId.split(":")[2] ?? nativeId, "series");
      if (identity) {
        const epNum = identity.seasons[0]?.episodeCount ?? 10;
        const episodes: Episode[] = [];
        for (let e = 1; e <= Math.min(epNum, 50); e++) {
          episodes.push({
            streamId: `yt:${encodeURIComponent(identity.title)}:1:${e}`,
            season: 1,
            episode: e,
            title: `${e}. Bölüm`,
          });
        }
        return {
          nativeId,
          type: "series",
          title: identity.title,
          poster: identity.poster,
          backdrop: identity.backdrop,
          synopsis: identity.synopsis,
          episodes,
        };
      }
    }

    const base = await resolveBaseUrl("urls.series.tvdiziler.base", DEFAULT_BASE, "mirrorUrl");
    const slug = decodeURIComponent(nativeId.replace(/^series:/, ""));
    const rawHtml = await fetchText(absoluteUrl(base, slug), {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`TvDiziler dizisi açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || slug)
      .replace(/\s*izle\s*(?:\(\d{4}\))?\s*$/i, "")
      .replace(/\s*\(\d{4}\)\s*$/i, "")
      .trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<string>();

    for (const a of doc.select('a[href*="bolum"]')) {
      const href = a.attr("href");
      if (
        !href ||
        href.startsWith("dizi/") ||
        href.includes("/dizi/") ||
        href.includes("tartisma/") ||
        href.includes("-son-bolum") ||
        /\.(?:jpg|jpeg|png|webp|css|js)(?:\?|$)/i.test(href)
      ) {
        continue;
      }
      const full = absoluteUrl(base, href);
      if (seen.has(full)) continue;
      seen.add(full);
      const txt = a.text().trim();
      const parsed = parseSeasonEpisode(txt || full, 1);
      const s = parsed?.season ?? 1;
      const e = parsed?.episode ?? episodes.length + 1;
      episodes.push({
        streamId: `ep:${encodeURIComponent(full)}`,
        season: s,
        episode: e,
        title: txt || `${e}. Bölüm`,
      });
    }
    if (episodes.length === 0) {
      for (let e = 1; e <= 5; e++) {
        episodes.push({
          streamId: `yt:${encodeURIComponent(title)}:1:${e}`,
          season: 1,
          episode: e,
          title: `${e}. Bölüm`,
        });
      }
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return {
      nativeId,
      type: "series",
      title,
      poster,
      backdrop: poster,
      seasons: [{ id: "1", season: 1, title: "Bölümler", episodeCount: episodes.length }],
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.tvdiziler.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("yt:")) {
        const [, encodedTitle, , epStr] = streamId.split(":");
        const title = decodeURIComponent(encodedTitle ?? "");
        const epNum = Number.parseInt(epStr ?? "1", 10) || 1;
        return finalizeStreams(await searchOfficialYouTubeEpisode(title, epNum, "TvDiziler"));
      }
      if (streamId.startsWith("ep:")) {
        const epUrl = decodeURIComponent(streamId.slice(3));
        const streams = await resolveTvDizilerEpisode(epUrl, base);
        if (streams.length > 0) return finalizeStreams(streams);
        const parsed = parseSeasonEpisode(epUrl, 1);
        const slugName = epUrl.split("/").pop()?.replace(/-\d+-bolum.*/i, "").replace(/-/g, " ") ?? "";
        if (slugName) {
          return finalizeStreams(await searchOfficialYouTubeEpisode(slugName, parsed?.episode ?? 1, "TvDiziler"));
        }
        return { streams: [] };
      }

      if (streamId.startsWith("series:")) {
        const detail = await this.getDetails!(streamId);
        const firstEp = detail.episodes[0];
        if (firstEp?.streamId.startsWith("ep:")) {
          const epStreams = await resolveTvDizilerEpisode(decodeURIComponent(firstEp.streamId.slice(3)), base);
          if (epStreams.length > 0) return finalizeStreams(epStreams);
        }
        if (detail.title) {
          return finalizeStreams(await searchOfficialYouTubeEpisode(detail.title, 1, "TvDiziler"));
        }
        return { streams: [] };
      }

      const parts = streamId.split(":");
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, "series");
      if (!identity) return { streams: [] };
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      const sr = await this.search!(identity.title, {}, 1);
      const best = pickBestCandidate(
        sr.items.map((x) => ({ title: x.title, nativeId: x.nativeId })),
        identity.title,
        identity.originalTitle,
      );
      if (best) {
        const detail = await this.getDetails!(best.nativeId);
        const ep = detail.episodes.find((x) => x.episode === eTarget);
        if (ep?.streamId.startsWith("ep:")) {
          const streams = await resolveTvDizilerEpisode(decodeURIComponent(ep.streamId.slice(3)), base);
          if (streams.length > 0) return finalizeStreams(streams);
        }
      }

      return finalizeStreams(
        await searchOfficialYouTubeEpisode(identity.title, eTarget, "TvDiziler"),
      );
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
