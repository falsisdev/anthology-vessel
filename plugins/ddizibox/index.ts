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
import {
  buildHeaders,
  fetchJson,
  fetchText,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractYear,
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractPilavyer } from "./shared/extractors/pilavyer.ts";

const DEFAULT_BASE = "https://ddizibox.click";

interface DdiziBoxSearchItem {
  title?: string;
  url?: string;
  poster?: string;
  meta?: string;
}

interface DdiziBoxLiveSearch {
  movies?: DdiziBoxSearchItem[];
  series?: DdiziBoxSearchItem[];
}

function classifyHref(href: string): { type: "movie" | "series"; isAnime: boolean } {
  const lower = href.toLowerCase();
  if (lower.includes("/anime/")) return { type: "series", isAnime: true };
  if (lower.includes("/film/")) return { type: "movie", isAnime: false };
  return { type: "series", isAnime: false };
}

function parseBoxCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const byUrl = new Map<string, MediaSummary>();

  for (const a of doc.select("a[href*='/film/'], a[href*='/dizi/'], a[href*='/anime/']")) {
    const href = a.attr("href");
    if (!href || href.includes("/sezon-") || href.includes("/bolum-")) continue;
    const full = absoluteUrl(base, href);
    const img = a.selectOne("img");
    const rawTitle =
      a.selectOne("h2, h3, .title")?.text() || img?.attr("alt") || a.text();
    const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    const poster =
      posterRaw && !posterRaw.startsWith("data:") ? absoluteUrl(base, posterRaw) : undefined;
    if (!title || title.length < 2 || /^(?:hemen\s+)?(?:izle|fragman|detay(?:lar)?|listeye\s+ekle)$/i.test(title)) {
      continue;
    }

    const prev = byUrl.get(full);
    if (!prev) {
      if (!poster) continue;
      const { type, isAnime } = classifyHref(full);
      byUrl.set(full, {
        nativeId: `${isAnime ? "anime" : type}:${encodeURIComponent(full)}`,
        type,
        isAnime,
        title,
        year: extractYear(title),
        poster,
      });
    } else if (!prev.poster && poster) {
      prev.poster = poster;
    }
  }
  return Array.from(byUrl.values());
}

async function resolvePilavyerOnPage(pageUrl: string, base: string) {
  const pageHtml = await fetchText(pageUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!pageHtml) return [];
  const pvMatch = /data-pv=["']([^"']+)["']/.exec(pageHtml);
  const hostMatch = /src=["'](https?:\/\/[^/]+)\/assets\/js\/core\.js["']/i.exec(pageHtml);
  if (pvMatch?.[1]) {
    const pv = await extractPilavyer({
      pvId: pvMatch[1],
      playerHost: hostMatch?.[1] ?? "https://play2.pilavyerplay.top",
      referer: `${base}/`,
      sourceLabel: "DDiziBox",
    });
    if (pv.streams.length > 0) return pv.streams;
  }

  const iframeMatch = /<iframe[^>]+src=["']([^"']*pilavyer[^"']+)["']/i.exec(pageHtml);
  if (iframeMatch?.[1]) {
    const pv = await extractPilavyer({
      playerUrl: absoluteUrl(base, iframeMatch[1]),
      referer: pageUrl,
      sourceLabel: "DDiziBox",
    });
    return pv.streams;
  }
  return [];
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.ddizibox.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const all = rawHtml ? parseBoxCards(rawHtml, base) : [];
      const movies = all.filter((x) => x.type === "movie").slice(0, 28);
      const series = all.filter((x) => x.type === "series" && !x.isAnime).slice(0, 28);
      const anime = all.filter((x) => x.isAnime).slice(0, 28);

      const sections: HomeFeed["sections"] = [
        { id: "series", title: "Öne Çıkan Diziler", layout: "poster" as const, items: series },
        { id: "movies", title: "Öne Çıkan Filmler", layout: "poster" as const, items: movies },
        { id: "anime", title: "Animeler", layout: "poster" as const, items: anime },
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
      const base = await resolveBaseUrl("urls.series.ddizibox.base", DEFAULT_BASE, "mirrorUrl");
      const json = await fetchJson<DdiziBoxLiveSearch>(
        `${base}/ara/oneri?q=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
      );

      const items: MediaSummary[] = [];
      const seen = new Set<string>();
      for (const raw of [...(json?.series ?? []), ...(json?.movies ?? [])]) {
        if (!raw.url || !raw.title) continue;
        const full = absoluteUrl(base, raw.url);
        if (seen.has(full)) continue;
        seen.add(full);
        const { type, isAnime } = classifyHref(full);
        items.push({
          nativeId: `${isAnime ? "anime" : type}:${encodeURIComponent(full)}`,
          type,
          isAnime,
          title: decodeHtmlEntities(raw.title).trim(),
          year: extractYear(raw.meta),
          poster: raw.poster ? absoluteUrl(base, raw.poster) : undefined,
        });
      }

      if (items.length === 0) {
        const sHtml = await fetchText(`${base}/ara?q=${encodeURIComponent(query.trim())}`, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        });
        if (sHtml) items.push(...parseBoxCards(sHtml, base));
      }

      return { items: items.slice(0, 30), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.ddizibox.base", DEFAULT_BASE, "mirrorUrl");
    const pageUrl = decodeURIComponent(nativeId.replace(/^(?:movie|series|anime):/, ""));
    const rawHtml = await fetchText(pageUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`DDiziBox içerik açılamadı: ${pageUrl}`);

    const doc = html.parse(rawHtml);
    const { type, isAnime } = classifyHref(pageUrl);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || "DDiziBox").trim();
    const poster =
      doc.selectOne('img[src*="tmdb/posters"]')?.attr("src") ??
      doc.selectOne('meta[property="og:image"]')?.attr("content") ??
      undefined;
    const backdrop = doc.selectOne('img[src*="tmdb/backdrops"]')?.attr("src") ?? poster;
    const synopsis =
      doc.selectOne('meta[name="description"]')?.attr("content") ??
      doc.selectOne("p.overview")?.text() ??
      undefined;

    if (type === "movie") {
      return {
        nativeId,
        type: "movie",
        isAnime,
        title,
        poster,
        backdrop,
        synopsis,
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
      isAnime,
      title,
      poster,
      backdrop,
      synopsis,
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.ddizibox.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("page:")) {
        return finalizeStreams(await resolvePilavyerOnPage(decodeURIComponent(streamId.slice(5)), base));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };

      const queries = [identity.title, identity.originalTitle].filter(Boolean);
      const candidates: Array<{ title: string; year?: number; url: string; type: "movie" | "series" }> = [];
      for (const q of queries) {
        const j = await fetchJson<DdiziBoxLiveSearch>(
          `${base}/ara/oneri?q=${encodeURIComponent(q)}`,
          { timeoutMs: 7_000, headers: buildHeaders(`${base}/`) },
        );
        const list = typeHint === "series" ? j?.series : j?.movies;
        for (const it of list ?? []) {
          if (!it.url || !it.title) continue;
          candidates.push({
            title: decodeHtmlEntities(it.title),
            year: extractYear(it.meta),
            url: absoluteUrl(base, it.url),
            type: classifyHref(it.url).type,
          });
        }
        if (candidates.length > 0) break;
      }

      const best = pickBestCandidate(candidates, identity.title, identity.originalTitle, identity.year);
      if (!best) return { streams: [] };

      const targetUrl =
        typeHint === "series"
          ? `${best.url.replace(/\/+$/, "")}/sezon-${parts[1] ?? "1"}/bolum-${parts[2] ?? "1"}`
          : best.url;
      return finalizeStreams(await resolvePilavyerOnPage(targetUrl, base));
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
