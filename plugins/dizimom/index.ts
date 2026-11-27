import { definePlugin, html } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import { buildHeaders, fetchText, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import {
  finalizeStreams,
  parseRouteId,
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import { absoluteUrl, decodeHtmlEntities, extractYear, parseSeasonEpisode } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractPilavyer } from "./shared/extractors/pilavyer.ts";
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://ddizimom.icu";

function parseMomCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select("a[href*='/dizi/'], a[href*='/film/']")) {
    const href = a.attr("href");
    if (!href || href.includes("/sezon-") || href.includes("/bolum-")) continue;
    const full = absoluteUrl(base, href);
    if (seen.has(full)) continue;
    const img = a.selectOne("img");
    const title = decodeHtmlEntities(
      a.selectOne("h2, h3, .title")?.text() || img?.attr("alt") || a.text(),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (
      !title ||
      title.length < 2 ||
      /^(?:[iİı]zle|hemen\s*[iİı]zle|fragman|detay|devam[ıi]\s*n[ıi]\s*oku)$/i.test(title)
    ) {
      continue;
    }
    const poster = img?.attr("data-src") || img?.attr("src");
    if (!poster || poster.startsWith("data:")) continue;
    seen.add(full);
    const kind: "movie" | "series" = full.includes("/film/") ? "movie" : "series";
    out.push({
      nativeId: `${kind}:${encodeURIComponent(full)}`,
      type: kind,
      title,
      year: extractYear(title),
      poster: absoluteUrl(base, poster),
    });
  }
  return out;
}

async function resolveMomEpisode(pageUrl: string, base: string) {
  const rawHtml = await fetchText(pageUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!rawHtml) return [];

  const pvMatch = /data-pv=["']([^"']+)["']/i.exec(rawHtml);
  if (pvMatch?.[1]) {
    const hostMatch = /src="(https?:\/\/[^/]+)\/assets\/js\/core\.js"/i.exec(rawHtml);
    const pv = await extractPilavyer({
      pvId: pvMatch[1],
      playerHost: hostMatch?.[1] ?? "https://play2.pilavyerplay.top",
      referer: `${base}/`,
      sourceLabel: "DiziMom",
    });
    if (pv.streams.length > 0) return pv.streams;
  }

  for (const ifr of html.parse(rawHtml).select("iframe[src], [data-src]")) {
    const src = ifr.attr("data-src") || ifr.attr("src");
    if (!src) continue;
    const resolved = await extractByEmbedUrl(absoluteUrl(base, src), {
      sourceLabel: "DiziMom",
      referer: pageUrl,
    });
    if (resolved.length > 0) return resolved;
  }
  return [];
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.dizimom.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, { timeoutMs: 3_500, headers: buildHeaders(`${base}/`) });
      const items = rawHtml ? parseMomCards(rawHtml, base) : [];
      const series = items.filter((i) => i.type === "series").slice(0, 30);
      const movies = items.filter((i) => i.type === "movie").slice(0, 30);
      const sections: HomeFeed["sections"] = [
        { id: "series", title: "Popüler Diziler", layout: "poster" as const, items: series },
        { id: "movies", title: "Filmler", layout: "poster" as const, items: movies },
      ].filter((s) => s.items.length > 0);
      return { sections };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(query, _filters, page): Promise<SearchPage> {
    try {
      if (page > 1 || !query.trim()) return { items: [], hasMore: false };
      const base = await resolveBaseUrl("urls.series.dizimom.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/ara?q=${encodeURIComponent(query.trim())}`, {
        timeoutMs: 5_000,
        headers: buildHeaders(`${base}/`),
      });
      return { items: rawHtml ? parseMomCards(rawHtml, base).slice(0, 30) : [], hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.dizimom.base", DEFAULT_BASE, "mirrorUrl");
    const pageUrl = decodeURIComponent(nativeId.replace(/^(?:movie|series):/, ""));
    const rawHtml = await fetchText(pageUrl, { timeoutMs: 10_000, headers: buildHeaders(`${base}/`) });
    if (!rawHtml) throw new Error(`DiziMom içerik açılamadı: ${pageUrl}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() || doc.selectOne("title")?.text().split("-")[0] || "DiziMom",
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;

    if (pageUrl.includes("/film/")) {
      return {
        nativeId,
        type: "movie",
        title,
        poster,
        backdrop: poster,
        episodes: [{ streamId: `page:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title }],
      };
    }

    const episodes: Episode[] = [];
    const seen = new Set<string>();
    for (const a of doc.select("a[href*='/sezon-'][href*='/bolum-']")) {
      const href = a.attr("href");
      if (!href) continue;
      const full = absoluteUrl(base, href);
      if (seen.has(full)) continue;
      seen.add(full);
      const parsed = parseSeasonEpisode(full, 1);
      const s = parsed?.season ?? 1;
      const e = parsed?.episode ?? episodes.length + 1;
      episodes.push({
        streamId: `page:${encodeURIComponent(full)}`,
        season: s,
        episode: e,
        title: `${s}. Sezon ${e}. Bölüm`,
      });
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const seasons: SeasonSummary[] = Array.from(new Set(episodes.map((e) => e.season))).map((s) => ({
      id: String(s),
      season: s,
      title: `${s}. Sezon`,
      episodeCount: episodes.filter((e) => e.season === s).length,
    }));

    return { nativeId, type: "series", title, poster, backdrop: poster, seasons, episodes };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.dizimom.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("page:")) {
        const pageUrl = decodeURIComponent(streamId.slice(5));
        return finalizeStreams(await resolveMomEpisode(pageUrl, base));
      }

      const route = parseRouteId(streamId);
      const typeHint: "movie" | "series" = route.mediaType === "movie" ? "movie" : "series";
      const identity = await resolveTmdbIdentity(route.id, typeHint);
      if (!identity) return { streams: [] };

      for (const q of [identity.title, identity.originalTitle].filter(Boolean)) {
        const sHtml = await fetchText(`${base}/ara?q=${encodeURIComponent(q)}`, {
          timeoutMs: 10_000,
          headers: buildHeaders(`${base}/`),
        });
        if (!sHtml) continue;
        const cands = parseMomCards(sHtml, base).map((c) => ({
          title: c.title,
          year: c.year,
          type: c.type,
          url: decodeURIComponent(c.nativeId.replace(/^(?:movie|series):/, "")),
        }));
        const filtered = cands.filter((c) => c.type === identity.mediaType);
        if (filtered.length === 0) continue;
        const best = pickBestCandidate(
          filtered,
          identity.title,
          identity.originalTitle,
          identity.year,
        );
        if (best) {
          let targetUrl = best.url;
          if (typeHint === "series") {
            const slug = best.url.replace(/\/+$/, "").split("/").pop() ?? "";
            targetUrl = `${base}/dizi/${slug}/sezon-${route.season}/bolum-${route.episode}`;
          }
          const streams = await resolveMomEpisode(targetUrl, base);
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
