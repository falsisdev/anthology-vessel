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
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractYear,
  parseSeasonEpisode,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractByEmbedUrl, extractFastplay } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://www.setfilmizle.ltd";

function parseSetCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select("a.card-link[href]")) {
    const href = a.attr("href");
    if (!href) continue;
    const full = absoluteUrl(base, href);
    if (seen.has(full)) continue;
    const img = a.selectOne("img");
    const rawTitle =
      a.selectOne("h2, h3")?.text() || img?.attr("alt") || "";
    const title = decodeHtmlEntities(rawTitle).trim();
    if (!title) continue;
    seen.add(full);
    const kind: "movie" | "series" = full.includes("/dizi/") ? "series" : "movie";
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    out.push({
      nativeId: `${kind}:${encodeURIComponent(full)}`,
      type: kind,
      title,
      year: extractYear(title),
      poster: posterRaw ? absoluteUrl(base, posterRaw) : undefined,
    });
  }
  return out;
}

async function extractSetPageStreams(
  pageUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const rawHtml = await fetchText(pageUrl, {
    timeoutMs: 12_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!rawHtml) return [];

  const doc = html.parse(rawHtml);
  const streams: StreamCandidate[] = [];

  for (const ifr of doc.select("iframe[src], [data-src]")) {
    const src = ifr.attr("data-src") || ifr.attr("src");
    if (!src) continue;
    const full = absoluteUrl(base, src);
    if (full.includes("setplay.") || full.includes("fastplay.")) {
      streams.push(
        ...(await extractFastplay(full, {
          sourceLabel: "SetFilmİzle",
          referer: pageUrl,
        })),
      );
    } else if (!full.includes("youtube.com")) {
      streams.push(
        ...(await extractByEmbedUrl(full, {
          sourceLabel: "SetFilmİzle",
          referer: pageUrl,
        })),
      );
    }
    if (streams.length > 0) return streams;
  }

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
    for (const btn of btns.slice(0, 4)) {
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
        const targetUrl = (j.data?.stream?.url ?? j.data?.url)?.replace(/\\\//g, "/");
        if (!targetUrl) continue;
        streams.push(
          ...(await extractByEmbedUrl(targetUrl, {
            sourceLabel: "SetFilmİzle",
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
      const base = await resolveBaseUrl(
        "urls.movies.setfilmizle.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const [moviesHtml, seriesHtml] = await Promise.all([
        fetchText(`${base}/tur/aksiyon/`, {
          timeoutMs: 10_000,
          headers: buildHeaders(`${base}/`),
        }),
        fetchText(`${base}/dizi/`, {
          timeoutMs: 10_000,
          headers: buildHeaders(`${base}/`),
        }),
      ]);

      const movies = moviesHtml ? parseSetCards(moviesHtml, base) : [];
      const series = seriesHtml ? parseSetCards(seriesHtml, base) : [];
      const sections: HomeFeed["sections"] = [
        { id: "movies", title: "Filmler", layout: "poster" as const, items: movies },
        { id: "series", title: "Yabancı Diziler", layout: "poster" as const, items: series },
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
      const base = await resolveBaseUrl(
        "urls.movies.setfilmizle.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const htmlText = await fetchText(
        `${base}/?s=${encodeURIComponent(query.trim())}`,
        { timeoutMs: 10_000, headers: buildHeaders(`${base}/`) },
      );
      const items = htmlText ? parseSetCards(htmlText, base) : [];
      return { items: items.slice(0, 30), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl(
      "urls.movies.setfilmizle.base",
      DEFAULT_BASE,
      "mirrorUrl",
    );
    const pageUrl = decodeURIComponent(nativeId.replace(/^(?:movie|series):/, ""));
    const rawHtml = await fetchText(pageUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`SetFilmİzle sayfası açılamadı: ${pageUrl}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() ||
        doc.selectOne("title")?.text().split("-")[0] ||
        "SetFilmİzle",
    ).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;

    if (pageUrl.includes("/dizi/")) {
      const episodes: Episode[] = [];
      const seen = new Set<string>();
      for (const panel of doc.select("div.season-panel[data-season]")) {
        const sNum = Number.parseInt(panel.attr("data-season") ?? "1", 10) || 1;
        let idx = 0;
        for (const epLink of panel.select("a.fep[href]")) {
          const href = epLink.attr("href");
          if (!href) continue;
          const full = absoluteUrl(base, href);
          if (seen.has(full)) continue;
          seen.add(full);
          idx++;
          const parsed = parseSeasonEpisode(full, sNum);
          const sN = parsed?.season ?? sNum;
          const eN = parsed?.episode ?? idx;
          episodes.push({
            streamId: `ep:${encodeURIComponent(full)}`,
            season: sN,
            episode: eN,
            title: `${sN}. Sezon ${eN}. Bölüm`,
          });
        }
      }

      if (episodes.length === 0) {
        for (const a of doc.select("ul.episodios a[href], a[href*='/bolum/']")) {
          const href = a.attr("href");
          if (!href) continue;
          const full = absoluteUrl(base, href);
          if (seen.has(full)) continue;
          seen.add(full);
          const parsed = parseSeasonEpisode(a.text() || full, 1);
          const sN = parsed?.season ?? 1;
          const eN = parsed?.episode ?? episodes.length + 1;
          episodes.push({
            streamId: `ep:${encodeURIComponent(full)}`,
            season: sN,
            episode: eN,
            title: `${sN}. Sezon ${eN}. Bölüm`,
          });
        }
      }

      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
      const seasons: SeasonSummary[] = Array.from(
        new Set(episodes.map((e) => e.season)),
      ).map((s) => ({
        id: String(s),
        season: s,
        title: `${s}. Sezon`,
        episodeCount: episodes.filter((e) => e.season === s).length,
      }));
      return {
        nativeId,
        type: "series",
        title,
        year: extractYear(title),
        poster,
        backdrop: poster,
        seasons,
        episodes,
      };
    }

    return {
      nativeId,
      type: "movie",
      title,
      year: extractYear(title),
      poster,
      backdrop: poster,
      episodes: [
        { streamId: `movie:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title },
      ],
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.setfilmizle.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      if (streamId.startsWith("movie:") || streamId.startsWith("ep:")) {
        const pageUrl = decodeURIComponent(streamId.split(":").slice(1).join(":"));
        return finalizeStreams(await extractSetPageStreams(pageUrl, base));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };

      for (const q of [identity.originalTitle, identity.title].filter(Boolean)) {
        const sHtml = await fetchText(`${base}/?s=${encodeURIComponent(q)}`, {
          timeoutMs: 10_000,
          headers: buildHeaders(`${base}/`),
        });
        if (!sHtml) continue;
        const cards = parseSetCards(sHtml, base).map((c) => ({
          title: c.title,
          year: c.year,
          type: c.type,
          url: decodeURIComponent(c.nativeId.replace(/^(?:movie|series):/, "")),
        }));
        const filtered = cards.filter((c) => c.type === identity.mediaType);
        const best = pickBestCandidate(
          filtered.length > 0 ? filtered : cards,
          identity.title,
          identity.originalTitle,
          identity.year,
        );
        if (best) {
          let targetUrl = best.url;
          if (typeHint === "series") {
            const detail = await this.getDetails!(
              `series:${encodeURIComponent(best.url)}`,
            );
            const s = Number.parseInt(parts[1] ?? "1", 10) || 1;
            const e = Number.parseInt(parts[2] ?? "1", 10) || 1;
            const ep = detail.episodes.find(
              (x) => x.season === s && x.episode === e,
            );
            if (!ep) return { streams: [] };
            targetUrl = decodeURIComponent(ep.streamId.replace(/^ep:/, ""));
          }
          return finalizeStreams(await extractSetPageStreams(targetUrl, base));
        }
      }

      return { streams: [] };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
