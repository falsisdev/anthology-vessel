import { definePlugin, html } from "vessel";
import type {
  AudioType,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  StreamCandidate,
} from "vessel";
import { configStringArray, resolveBaseUrl } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchText,
  postForm,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractYear,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import {
  extractByEmbedUrl,
  extractFastplay,
  extractVidmoxy,
  extractVidrame,
} from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASES = [
  "https://www.hdfilmizle.ink",
  "https://www.hdfilmizle.vip",
];

interface VipSearchItem {
  slug?: string;
  name?: string;
  thumb_url?: string;
  year?: string | number;
}

interface FilmIzlePart {
  lang?: string;
  data?: string;
}

interface ScrapedCard {
  title: string;
  href: string;
  poster?: string;
  year?: number;
}

function parseFilmIzleCards(rawHtml: string, base: string): ScrapedCard[] {
  const doc = html.parse(rawHtml);
  const out: ScrapedCard[] = [];
  const seen = new Set<string>();

  for (const a of doc.select("a.poster[href], article.item a[href*='/film/'], article.item .poster a[href]")) {
    const href = a.attr("href");
    if (!href) continue;
    const full = absoluteUrl(base, href);
    if (seen.has(full)) continue;
    const img = a.selectOne("img");
    const rawTitle = a.attr("title") || img?.attr("alt") || a.text();
    const title = decodeHtmlEntities(rawTitle).trim();
    if (!title) continue;
    seen.add(full);
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    out.push({
      title,
      href: full,
      poster: posterRaw ? absoluteUrl(base, posterRaw) : undefined,
      year: extractYear(title),
    });
  }
  return out;
}

function cardToSummary(c: ScrapedCard): MediaSummary {
  const kind: "movie" | "series" = c.href.includes("/dizi/") ? "series" : "movie";
  return {
    nativeId: `${kind}:${encodeURIComponent(c.href)}`,
    type: kind,
    title: c.title,
    year: c.year,
    poster: c.poster,
  };
}

async function resolveBases(): Promise<string[]> {
  const primary = await resolveBaseUrl(
    "urls.movies.hdfilmizle.base",
    DEFAULT_BASES[0]!,
    "mirrorUrl",
  );
  const cfgList = await configStringArray("urls.movies.hdfilmizle.bases", DEFAULT_BASES);
  const merged = [primary, ...cfgList.filter((u) => u !== primary)];
  return merged;
}

async function searchAllBases(query: string, bases: string[]): Promise<ScrapedCard[]> {
  const vipBase = bases[0] ?? DEFAULT_BASES[0]!;
  const vipRes = await postForm(
    `${vipBase}/search/`,
    { query },
    { timeoutMs: 8_000, headers: { Referer: `${vipBase}/` } },
  );
  if (vipRes && vipRes.status >= 200 && vipRes.status < 300) {
    try {
      const items = vipRes.json<VipSearchItem[]>();
      if (Array.isArray(items) && items.length > 0) {
        return items
          .filter((it) => Boolean(it.slug))
          .map((it) => ({
            title: decodeHtmlEntities(it.name ?? it.slug!).trim(),
            href: `${vipBase}/${it.slug!.replace(/^\/+|\/+$/g, "")}/`,
            poster: it.thumb_url ? absoluteUrl(vipBase, it.thumb_url) : undefined,
            year: extractYear(String(it.year ?? "")),
          }));
      }
    } catch {
      // Ignore malformed VIP response
    }
  }

  for (const base of bases) {
    const htmlText = await fetchText(
      `${base}/?s=${encodeURIComponent(query)}`,
      { timeoutMs: 10_000, headers: buildHeaders(`${base}/`) },
    );
    if (!htmlText) continue;
    const cards = parseFilmIzleCards(htmlText, base);
    if (cards.length > 0) return cards;
  }
  return [];
}

async function extractPageStreams(
  pageUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const rawHtml = await fetchText(pageUrl, {
    timeoutMs: 12_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!rawHtml) return [];

  const streams: StreamCandidate[] = [];
  const partsMatch = /let\s+parts\s*=\s*(\[[\s\S]*?\]);/.exec(rawHtml);
  if (partsMatch?.[1]) {
    try {
      const parts = JSON.parse(partsMatch[1]) as FilmIzlePart[];
      const partTasks: Array<Promise<StreamCandidate[]>> = [];
      for (const part of parts) {
        if (!part.data) continue;
        const ifrMatch = /src=["']([^"']+)["']/i.exec(part.data);
        if (!ifrMatch?.[1]) continue;
        const iframeUrl = ifrMatch[1].replace(/\\\//g, "/");
        const audioType: AudioType =
          part.lang === "tr" ? "dub" : part.lang === "dual" ? "original" : "sub";
        const opts = {
          sourceLabel: "HDFilmİzle",
          audioType,
          referer: pageUrl,
        };
        if (iframeUrl.includes("vidrame.")) {
          partTasks.push(extractVidrame(iframeUrl, opts));
        } else if (iframeUrl.includes("vidmoxy.")) {
          partTasks.push(extractVidmoxy(iframeUrl, opts));
        } else if (iframeUrl.includes("fastplay.") || iframeUrl.includes("setplay.")) {
          partTasks.push(extractFastplay(iframeUrl, opts));
        } else {
          partTasks.push(extractByEmbedUrl(iframeUrl, opts));
        }
      }
      if (partTasks.length > 0) {
        streams.push(...(await Promise.all(partTasks)).flat());
      }
    } catch {
      // Ignore invalid parts payload
    }
  }
  if (streams.length > 0) return streams;

  // Legacy WordPress admin-ajax fallback (hdfilmizle.ink)
  const doc = html.parse(rawHtml);
  const ajaxMatch = /["'](https?:[^"']*wp-admin\/admin-ajax\.php)["']/.exec(rawHtml);
  const ajaxUrl = ajaxMatch?.[1]?.replace(/\\\//g, "/") ?? `${base}/wp-admin/admin-ajax.php`;
  const nonces = Array.from(
    new Set([
      ...(rawHtml.match(/window\.STF_AJAX[\s\S]*?video\s*:\s*"([a-z0-9]+)"/)?.[1]
        ? [rawHtml.match(/window\.STF_AJAX[\s\S]*?video\s*:\s*"([a-z0-9]+)"/)![1]!]
        : []),
      ...Array.from(rawHtml.matchAll(/data-nonce="([a-z0-9]+)"/gi)).map((m) => m[1]!),
    ]),
  );
  if (nonces.length === 0) return [];

  const postIds = Array.from(
    new Set(
      doc
        .select("[data-post-id]")
        .map((el) => el.attr("data-post-id"))
        .filter((v): v is string => Boolean(v && !v.includes("event") && !v.includes("$"))),
    ),
  );
  const btns = doc
    .select("[data-player-name]")
    .map((el) => ({
      name: el.attr("data-player-name") ?? "",
      key: el.attr("data-part-key") ?? "",
    }))
    .filter((b) => b.name && !b.name.includes("$"));

  for (const postId of postIds.slice(0, 2)) {
    for (const btn of btns.slice(0, 3)) {
      for (const nonce of nonces) {
        const res = await postForm(
          ajaxUrl,
          {
            action: "get_video_url",
            nonce,
            post_id: postId,
            player_name: btn.name,
            part_key: btn.key,
          },
          {
            timeoutMs: 10_000,
            headers: {
              Referer: pageUrl,
              Origin: base,
              "X-Requested-With": "XMLHttpRequest",
            },
          },
        );
        if (!res || res.status < 200 || res.status >= 300) continue;
        let j: {
          success?: boolean;
          data?: { url?: string; stream?: { url?: string } };
        } | null = null;
        try {
          j = res.json<{
            success?: boolean;
            data?: { url?: string; stream?: { url?: string } };
          }>();
        } catch {
          continue;
        }
        if (!j || j.success === false) continue;
        const playerUrl = (j.data?.stream?.url ?? j.data?.url)?.replace(/\\\//g, "/");
        if (!playerUrl) continue;
        streams.push(
          ...(await extractByEmbedUrl(playerUrl, {
            sourceLabel: "HDFilmİzle",
            referer: pageUrl,
          })),
        );
        if (streams.length > 0) return streams;
      }
    }
  }
  return streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const bases = await resolveBases();
      for (const base of bases) {
        const target = base.includes("vip") ? `${base}/` : `${base}/film/`;
        const htmlText = await fetchText(target, {
          timeoutMs: 10_000,
          headers: buildHeaders(`${base}/`),
        });
        if (!htmlText) continue;
        const cards = parseFilmIzleCards(htmlText, base);
        if (cards.length > 0) {
          return {
            sections: [
              {
                id: "latest",
                title: "Yeni Filmler",
                layout: "poster",
                items: cards.slice(0, 30).map(cardToSummary),
              },
            ],
          };
        }
      }
      return { sections: [] };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(query, _filters, page): Promise<SearchPage> {
    try {
      if (page > 1 || !query.trim()) return { items: [], hasMore: false };
      const bases = await resolveBases();
      const cards = await searchAllBases(query.trim(), bases);
      return { items: cards.slice(0, 30).map(cardToSummary), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const bases = await resolveBases();
    const pageUrl = decodeURIComponent(nativeId.replace(/^(?:movie|series):/, ""));
    const base = new URL(pageUrl).origin || bases[0]!;
    const rawHtml = await fetchText(pageUrl, { headers: buildHeaders(`${base}/`) });
    if (!rawHtml) throw new Error(`HDFilmİzle içerik açılamadı: ${pageUrl}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() ||
        doc.selectOne("title")?.text().split("-")[0] ||
        "HDFilmİzle",
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    return {
      nativeId,
      type: pageUrl.includes("/dizi/") ? "series" : "movie",
      title,
      year: extractYear(title),
      poster,
      backdrop: poster,
      episodes: [
        { streamId: `page:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title },
      ],
    };
  },

  async getStreams(streamId) {
    try {
      const bases = await resolveBases();
      if (streamId.startsWith("page:") || streamId.startsWith("movie:")) {
        const pageUrl = decodeURIComponent(streamId.split(":").slice(1).join(":"));
        const origin = new URL(pageUrl).origin;
        return finalizeStreams(await extractPageStreams(pageUrl, origin));
      }

      const identity = await resolveTmdbIdentity(streamId.split(":")[0] ?? streamId, "movie");
      if (!identity) return { streams: [] };

      for (const q of [identity.originalTitle, identity.title].filter(Boolean)) {
        const cards = await searchAllBases(q, bases);
        const best = pickBestCandidate(
          cards,
          identity.title,
          identity.originalTitle,
          identity.year,
        );
        if (best) {
          const origin = new URL(best.href).origin;
          const streams = await extractPageStreams(best.href, origin);
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
