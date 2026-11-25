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
import { buildHeaders, fetchText, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import {
  dedupeMediaSummaries,
  extractUniqueFrameUrls,
  finalizeStreams,
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import { absoluteUrl, decodeHtmlEntities, ultraClean } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { collectAnimeSearchTitles } from "./shared/core/anime-helpers.ts";
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://asyaanimeleri.top";

function parseCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const card of doc.select("article.bs a[href*='/series/'], .listupd a[href*='/series/']")) {
    const href = card.attr("href");
    if (!href) continue;
    const full = absoluteUrl(base, href).replace(/\/+$/, "");
    const slug = full.split("/series/")[1]?.replace(/\/+$/, "") ?? "";
    if (!slug || seen.has(slug)) continue;
    const img = card.selectOne("img");
    const rawTitle = card.attr("title") || img?.attr("alt") || card.text();
    const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
    if (!title || title.length < 2) continue;
    seen.add(slug);
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `anime:${slug}`,
      type: "series",
      isAnime: true,
      title,
      poster: posterRaw ? absoluteUrl(base, posterRaw) : undefined,
    });
  }
  return items;
}

function parseEpisodeNum(rawHref: string, numText: string, fallback: number): number {
  const numFromText = /(\d+)/.exec(numText)?.[1];
  if (numFromText) return Number.parseInt(numFromText, 10) || fallback;
  const slugMatch = /-(\d+)(?:-bolum|-episode|-part)?\/?$/i.exec(rawHref);
  if (slugMatch?.[1]) return Number.parseInt(slugMatch[1], 10) || fallback;
  return fallback;
}

async function resolveAsyaEpisodeStreams(
  epUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const rawHtml = await fetchText(epUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!rawHtml) return [];

  const frameUrls = new Set<string>(extractUniqueFrameUrls(rawHtml, base));
  const doc = html.parse(rawHtml);
  for (const opt of doc.select("select.mirror option[value], option[value]")) {
    const val = opt.attr("value")?.trim();
    if (!val || val.length < 16 || val.startsWith("http")) continue;
    try {
      const decoded = atob(val);
      for (const u of extractUniqueFrameUrls(decoded, base)) {
        frameUrls.add(u);
      }
    } catch {
      // Ignore non-base64 option values.
    }
  }

  const out: StreamCandidate[] = [];
  for (const src of Array.from(frameUrls)) {
    out.push(
      ...(await extractByEmbedUrl(src, {
        sourceLabel: "AsyaAnimeleri",
        audioType: "sub",
        language: "ja",
        referer: epUrl,
      })),
    );
  }
  return out;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.anime.asyaanimeleri.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/series/?order=popular`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const items = rawHtml ? dedupeMediaSummaries(parseCards(rawHtml, base)) : [];
      return {
        sections:
          items.length > 0
            ? [{ id: "popular", title: "Popüler Animeler", layout: "poster", items }]
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
      const base = await resolveBaseUrl("urls.anime.asyaanimeleri.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/?s=${encodeURIComponent(query.trim())}`, {
        timeoutMs: 9_000,
        headers: buildHeaders(`${base}/`),
      });
      return {
        items: rawHtml ? dedupeMediaSummaries(parseCards(rawHtml, base)).slice(0, 30) : [],
        hasMore: false,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.anime.asyaanimeleri.base", DEFAULT_BASE, "mirrorUrl");
    const slug = nativeId.replace(/^anime:/, "").replace(/\/+$/, "");
    const rawHtml = await fetchText(`${base}/series/${slug}/`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`AsyaAnimeleri serisi açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1.entry-title, h1")?.text() || slug,
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const synopsis = doc.selectOne(".entry-content p")?.text().trim() || undefined;

    const rawEps: Episode[] = [];
    const seen = new Set<string>();
    const links = doc.select(".eplister li a[href], div.eplister a[href]");
    for (let i = 0; i < links.length; i++) {
      const a = links[i]!;
      const href = a.attr("href");
      if (!href) continue;
      const full = absoluteUrl(base, href);
      if (seen.has(full)) continue;
      seen.add(full);
      const numTxt = a.selectOne(".epl-num")?.text() ?? a.text();
      const epNum = parseEpisodeNum(full, numTxt, links.length - i);
      rawEps.push({
        streamId: `ep:${encodeURIComponent(full)}`,
        season: 1,
        episode: epNum,
        title: `${epNum}. Bölüm`,
      });
    }
    rawEps.sort((a, b) => a.episode - b.episode);

    const seasons: SeasonSummary[] =
      rawEps.length > 0
        ? [{ id: "1", season: 1, title: "1. Sezon", episodeCount: rawEps.length }]
        : [];

    return {
      nativeId,
      type: "series",
      isAnime: true,
      title,
      poster,
      backdrop: poster,
      synopsis,
      genres: ["Anime"],
      seasons,
      episodes: rawEps,
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.anime.asyaanimeleri.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("ep:")) {
        return finalizeStreams(
          await resolveAsyaEpisodeStreams(decodeURIComponent(streamId.slice(3)), base),
        );
      }
      if (streamId.startsWith("anime:")) {
        const det = await this.getDetails!(streamId);
        const ep = det.episodes[0];
        if (!ep) return { streams: [] };
        return finalizeStreams(
          await resolveAsyaEpisodeStreams(decodeURIComponent(ep.streamId.slice(3)), base),
        );
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] || parts.length === 1 ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };
      const sTarget = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      for (const q of collectAnimeSearchTitles(identity).slice(0, 4)) {
        const sr = await this.search!(q, {}, 1);
        if (sr.items.length === 0) continue;

        let chosen = sr.items[0]!;
        if (sTarget > 1) {
          const sRe = new RegExp(`(?:${sTarget}\\.?[\\s-]*sezon|season[\\s-]*${sTarget})`, "i");
          const sHit = sr.items.find((x) => sRe.test(x.title) || sRe.test(x.nativeId));
          if (sHit) chosen = sHit;
        } else {
          const picked = pickBestCandidate(
            sr.items.map((x) => ({
              title: x.title,
              nativeId: x.nativeId,
              clean: ultraClean(x.title),
            })),
            identity.title,
            identity.originalTitle,
          );
          if (picked) {
            chosen = sr.items.find((x) => x.nativeId === picked.nativeId) ?? chosen;
          }
        }

        const det = await this.getDetails!(chosen.nativeId);
        const ep = det.episodes.find((x) => x.episode === eTarget) ?? det.episodes[0];
        if (ep) {
          const streams = await resolveAsyaEpisodeStreams(
            decodeURIComponent(ep.streamId.slice(3)),
            base,
          );
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
