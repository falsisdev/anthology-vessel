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
  extractUniqueFrameUrls,
  finalizeStreams,
  parseRouteId,
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://diziboxizle.com";

interface WpCategoryItem {
  slug?: string;
  name?: string;
  count?: number;
}

interface WpPostItem {
  link?: string;
  title?: { rendered?: string };
}

function parseBoxIzleCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const box of doc.select("#list-series .episode-box, .episode-box, article, .poster")) {
    const a = box.selectOne("a[href]");
    const href = a?.attr("href");
    if (!href || href.includes("-bolum")) continue;
    const full = absoluteUrl(base, href).replace(/\/+$/, "");
    const slug = full.split("/").pop() ?? "";
    if (!slug || seen.has(slug)) continue;
    const img = box.selectOne("img");
    const rawTitle =
      box.selectOne(".episode-title, .categorytitle, h2, h3")?.text() ||
      a?.attr("title") ||
      img?.attr("alt") ||
      a?.text() ||
      "";
    const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
    if (!title || title.length < 2) continue;
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    const poster =
      posterRaw && !posterRaw.startsWith("data:") ? absoluteUrl(base, posterRaw) : undefined;
    seen.add(slug);
    out.push({
      nativeId: `series:${slug}`,
      type: "series",
      title,
      poster,
    });
  }

  for (const a of doc.select(".categorytitle a[href], #list-series a[href]")) {
    const href = a.attr("href");
    if (!href || href.includes("-bolum")) continue;
    const full = absoluteUrl(base, href).replace(/\/+$/, "");
    const slug = full.split("/").pop() ?? "";
    if (!slug || seen.has(slug)) continue;
    const title = decodeHtmlEntities(a.text()).trim();
    if (!title || title.length < 2) continue;
    seen.add(slug);
    const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    out.push({
      nativeId: `series:${slug}`,
      type: "series",
      title,
      poster: posterRaw && !posterRaw.startsWith("data:") ? absoluteUrl(base, posterRaw) : undefined,
    });
  }
  return out;
}

async function resolveBoxIzleEpisode(
  epUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const epHtml = await fetchText(epUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!epHtml) return [];

  const doc = html.parse(epHtml);
  const containersHtml = doc
    .select("div.video-container, div.video-content")
    .map((el) => el.html())
    .join("\n");
  const frames = extractUniqueFrameUrls(containersHtml || epHtml, base);
  if (frames.length === 0 && containersHtml) {
    frames.push(...extractUniqueFrameUrls(epHtml, base));
  }
  const streams: StreamCandidate[] = [];
  for (const src of frames) {
    streams.push(
      ...(await extractByEmbedUrl(src, {
        sourceLabel: "DiziBoxİzle",
        referer: epUrl,
      })),
    );
  }
  return streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.diziboxizle.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 8_000,
        headers: buildHeaders(`${base}/`),
      });
      let items: MediaSummary[] = rawHtml ? parseBoxIzleCards(rawHtml, base) : [];
      if (items.length === 0) {
        const cats = await fetchJson<WpCategoryItem[]>(
          `${base}/wp-json/wp/v2/categories?per_page=36&orderby=count&order=desc&hide_empty=true`,
          { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
        );
        items = (cats ?? [])
          .filter((c) => c.slug && c.name)
          .map((c) => ({
            nativeId: `series:${c.slug!}`,
            type: "series",
            title: decodeHtmlEntities(c.name!).trim(),
          }));
      }
      return {
        sections:
          items.length > 0
            ? [{ id: "series", title: "Yabancı Diziler", layout: "poster", items: dedupeMediaSummaries(items) }]
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
      const base = await resolveBaseUrl("urls.series.diziboxizle.base", DEFAULT_BASE, "mirrorUrl");
      const cleanQ = query.trim().replace(/['’`]/g, " ").replace(/\s+/g, " ").trim();
      const [cats, posts, sHtml] = await Promise.all([
        fetchJson<WpCategoryItem[]>(
          `${base}/wp-json/wp/v2/categories?search=${encodeURIComponent(cleanQ)}&per_page=25&hide_empty=true`,
          { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
        ),
        fetchJson<WpPostItem[]>(
          `${base}/wp-json/wp/v2/posts?search=${encodeURIComponent(cleanQ)}&per_page=20`,
          { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
        ),
        fetchText(`${base}/?s=${encodeURIComponent(cleanQ)}`, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        }),
      ]);

      const items: MediaSummary[] = (cats ?? [])
        .filter((c) => c.slug && c.name && (c.count ?? 1) > 0)
        .map((c) => ({
          nativeId: `series:${c.slug!}`,
          type: "series",
          title: decodeHtmlEntities(c.name!).trim(),
        }));
      for (const post of posts ?? []) {
        if (!post.link || !post.title?.rendered) continue;
        const cleanTitle = decodeHtmlEntities(post.title.rendered).replace(/<[^>]+>/g, "").trim();
        const showSlug = post.link
          .replace(/^https?:\/\/[^/]+\//i, "")
          .replace(/-\d+-sezon-\d+-bolum.*$/, "")
          .replace(/\/+$/, "");
        if (!showSlug || items.some((x) => x.nativeId === `series:${showSlug}`)) continue;
        items.push({
          nativeId: `series:${showSlug}`,
          type: "series",
          title: cleanTitle.replace(/\s+\d+\.\s*Sezon.*$/i, "").trim() || cleanTitle,
        });
      }
      if (sHtml) items.push(...parseBoxIzleCards(sHtml, base));
      return { items: dedupeMediaSummaries(items).slice(0, 30), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.diziboxizle.base", DEFAULT_BASE, "mirrorUrl");
    const slug = nativeId.replace(/^series:/, "");
    const rawHtml = await fetchText(`${base}/${slug}/`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`DiziBoxİzle dizisi açılamadı: ${slug}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || slug)
      .replace(/\s*(?:Dizisi\s+izle.*|\|\s*DiziBOX.*)$/i, "")
      .trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<string>();

    for (const a of doc.select('a[href*="-bolum"]')) {
      const href = a.attr("href");
      if (!href || href.includes("/tum-bolumler")) continue;
      if (!/(?:sezon-\d+[-/])?\d+-bolum/i.test(href) && !/\d+\.?\s*b[oö]l[uü]m/i.test(a.text())) {
        continue;
      }
      const full = absoluteUrl(base, href);
      if (seen.has(full)) continue;
      seen.add(full);
      const parsed = parseSeasonEpisode(a.text() || full, 1);
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
      const base = await resolveBaseUrl("urls.series.diziboxizle.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("ep:")) {
        return finalizeStreams(await resolveBoxIzleEpisode(decodeURIComponent(streamId.slice(3)), base));
      }

      const route = parseRouteId(streamId);
      const identity = await resolveTmdbIdentity(route.id, "series");
      if (!identity) return { streams: [] };
      const sTarget = route.season;
      const eTarget = route.episode;

      const sr = await this.search!(identity.title, {}, 1);
      const best = pickBestCandidate(
        sr.items.map((x) => ({ title: x.title, nativeId: x.nativeId })),
        identity.title,
        identity.originalTitle,
      );
      if (!best) return { streams: [] };

      const detail = await this.getDetails!(best.nativeId);
      const ep =
        detail.episodes.find((x) => x.season === sTarget && x.episode === eTarget) ??
        (sTarget === 1 ? detail.episodes.find((x) => x.episode === eTarget) : undefined);
      if (!ep) return { streams: [] };

      return finalizeStreams(await resolveBoxIzleEpisode(decodeURIComponent(ep.streamId.slice(3)), base));
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
