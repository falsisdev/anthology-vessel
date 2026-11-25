import { definePlugin, html, unpack } from "vessel";
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
  dedupeMediaSummaries,
  finalizeStreams,
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import { createStream, inferStreamKind } from "./shared/core/quality.ts";
import { absoluteUrl, decodeHtmlEntities, parseSeasonEpisode } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://dizibak.net";

interface LiveSearchPayload {
  data?: {
    diziler?: Array<{
      title?: string;
      link?: string;
      thumb?: string;
      slugOrId?: string;
    }>;
  };
}

async function resolveDizibakPlayer(
  epUrl: string,
  base: string,
  playerHost: string,
): Promise<StreamCandidate[]> {
  const epHtml = await fetchText(epUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!epHtml) return [];

  const postId = /data-post-id="(\d+)"/.exec(epHtml)?.[1];
  const nonce = /data-nonce="([^"]+)"/.exec(epHtml)?.[1];
  if (!postId || !nonce) return [];

  const res = await postForm(
    `${base}/wp-admin/admin-ajax.php`,
    { action: "load_player_content", post_id: postId, nonce },
    {
      timeoutMs: 10_000,
      headers: {
        Referer: epUrl,
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!res || res.status >= 400) return [];

  let iframeHtml = "";
  try {
    iframeHtml = res.json<{ data?: string }>().data ?? "";
  } catch {
    return [];
  }
  const ifrMatch = /<iframe[^>]+src=["']([^"']+)["']/i.exec(iframeHtml);
  if (!ifrMatch?.[1]) return [];

  let embedUrl = ifrMatch[1].replace(/\\\//g, "/");
  if (embedUrl.includes("player.dizibak.net") || embedUrl.includes("dizibak.net")) {
    embedUrl = embedUrl.replace(/^https?:\/\/[^/]+/, playerHost);
  }
  embedUrl = absoluteUrl(base, embedUrl);

  const embHtml = await fetchText(embedUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(epUrl),
  });
  if (!embHtml) return [];

  const packedMatch =
    /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k[\s\S]*?(?:<\/script>|$)/i.exec(
      embHtml,
    )?.[0];
  let decoded = embHtml;
  if (packedMatch) {
    try {
      decoded = unpack(packedMatch.replace(/<\/script>$/i, "").trim());
    } catch {
      decoded = embHtml;
    }
  }
  const searchPool = `${decoded}\n${embHtml}`;
  const fileRe = /file["']?\s*:\s*["']([^"']+)["']/g;
  const streams: StreamCandidate[] = [];
  const seen = new Set<string>();
  let fm: RegExpExecArray | null;
  while ((fm = fileRe.exec(searchPool)) !== null) {
    const raw = (fm[1] ?? "").replace(/\\\\\//g, "/").replace(/\\\//g, "/");
    if (!raw || (!raw.includes(".m3u8") && !raw.includes(".mp4")) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    const kind = inferStreamKind(raw);
    streams.push(
      createStream({
        url: raw,
        kind,
        quality: "1080p",
        label: `DiziBak • 1080p ${kind === "mp4" ? "MP4" : "HLS"}`,
        headers: buildHeaders(`${playerHost}/`),
      }),
    );
  }
  return streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.dizibak.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      if (!rawHtml) return { sections: [] };

      const doc = html.parse(rawHtml);
      const items: MediaSummary[] = [];
      const seen = new Set<string>();

      for (const art of doc.select("article.article-series-poster, article")) {
        const a = art.selectOne('a[href*="/diziler/"], a.poster-title[href], a[href]');
        const href = a?.attr("href");
        if (!href) continue;
        const full = absoluteUrl(base, href).replace(/\/+$/, "");
        const slug = full.split("/").pop() ?? "";
        if (!slug || seen.has(slug)) continue;

        const img = art.selectOne("img");
        const title = decodeHtmlEntities(
          art.selectOne(".poster-title, h2, h3")?.text() || a?.attr("title") || img?.attr("alt") || slug,
        )
          .replace(/\s+(?:Türkçe\s+altyazılı\s+)?izle$/i, "")
          .trim();
        if (!title || title.length < 2) continue;

        seen.add(slug);
        const rawPoster = img?.attr("data-src") || img?.attr("src");
        const yearNum = Number.parseInt(art.selectOne(".release")?.text().trim() ?? "", 10);
        const ratingNum = Number.parseFloat(art.selectOne(".imdb")?.text().trim() ?? "");
        items.push({
          nativeId: `series:${slug}`,
          type: "series",
          title,
          year: Number.isFinite(yearNum) && yearNum > 1900 ? yearNum : undefined,
          rating: Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum : undefined,
          poster:
            rawPoster && !rawPoster.startsWith("data:")
              ? absoluteUrl(base, rawPoster)
              : undefined,
        });
      }

      if (items.length === 0) {
        for (const a of doc.select('a[href*="-sezon-"][href*="-bolum"]')) {
          const href = a.attr("href");
          if (!href) continue;
          const full = absoluteUrl(base, href).replace(/\/+$/, "");
          const slug = full.split("/").pop()?.replace(/-\d+-sezon-\d+-bolum.*$/, "") ?? "";
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);
          const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
          const poster = img?.attr("data-src") || img?.attr("src");
          items.push({
            nativeId: `series:${slug}`,
            type: "series",
            title: slug
              .split("-")
              .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
              .join(" "),
            poster: poster && !poster.startsWith("data:") ? absoluteUrl(base, poster) : undefined,
          });
        }
      }

      return {
        sections:
          items.length > 0
            ? [
                {
                  id: "latest",
                  title: "Son Eklenen Diziler",
                  layout: "poster",
                  items: dedupeMediaSummaries(items).slice(0, 36),
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
      const base = await resolveBaseUrl("urls.series.dizibak.base", DEFAULT_BASE, "mirrorUrl");
      const homeHtml = await fetchText(`${base}/`, { headers: buildHeaders(`${base}/`) });
      const nonce =
        homeHtml
          ? /live_search_obj[\s\S]*?nonce["']?\s*[:=]\s*["']([^"']+)["']/.exec(homeHtml)?.[1] ?? ""
          : "";

      const res = await postForm(
        `${base}/wp-admin/admin-ajax.php`,
        { action: "live_search", keyword: query.trim(), nonce },
        {
          timeoutMs: 8_000,
          headers: { Referer: `${base}/`, "X-Requested-With": "XMLHttpRequest" },
        },
      );
      if (res && res.status < 400) {
        try {
          const payload = res.json<LiveSearchPayload>();
          const items: MediaSummary[] = [];
          for (const item of payload.data?.diziler ?? []) {
            if (!item.title) continue;
            const link = item.link ? absoluteUrl(base, item.link) : "";
            const slug =
              item.slugOrId ||
              link.replace(/\/+$/, "").split("/").pop() ||
              item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            items.push({
              nativeId: `series:${slug}`,
              type: "series",
              title: decodeHtmlEntities(item.title).trim(),
              poster: item.thumb ? absoluteUrl(base, item.thumb) : undefined,
            });
          }
          if (items.length > 0) {
            return { items: dedupeMediaSummaries(items), hasMore: false };
          }
        } catch {
          // Fall back to WordPress HTML search below.
        }
      }

      const sHtml = await fetchText(`${base}/?s=${encodeURIComponent(query.trim())}`, {
        timeoutMs: 8_000,
        headers: buildHeaders(`${base}/`),
      });
      if (!sHtml) return { items: [], hasMore: false };
      const doc = html.parse(sHtml);
      const htmlItems: MediaSummary[] = [];
      for (const art of doc.select("article.article-series-poster, article")) {
        const a = art.selectOne('a[href*="/diziler/"], a.poster-title[href], a[href]');
        const href = a?.attr("href");
        if (!href) continue;
        const full = absoluteUrl(base, href).replace(/\/+$/, "");
        const slug = full.split("/").pop() ?? "";
        if (!slug) continue;
        const img = art.selectOne("img");
        const title = decodeHtmlEntities(
          art.selectOne(".poster-title, h2, h3")?.text() || a?.attr("title") || img?.attr("alt") || slug,
        )
          .replace(/\s+(?:Türkçe\s+altyazılı\s+)?izle$/i, "")
          .trim();
        if (!title || title.length < 2) continue;
        const rawPoster = img?.attr("data-src") || img?.attr("src");
        htmlItems.push({
          nativeId: `series:${slug}`,
          type: "series",
          title,
          poster: rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined,
        });
      }
      return { items: dedupeMediaSummaries(htmlItems), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.dizibak.base", DEFAULT_BASE, "mirrorUrl");
    const slug = nativeId.replace(/^series:/, "");
    const showHtml = await fetchText(`${base}/diziler/${slug}/`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!showHtml) throw new Error(`DiziBak dizisi bulunamadı: ${slug}`);

    const doc = html.parse(showHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || slug).trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const episodes: Episode[] = [];
    const seen = new Set<string>();

    for (const a of doc.select('a[href*="-sezon-"][href*="-bolum"]')) {
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

    return { nativeId, type: "series", title, poster, backdrop: poster, seasons, episodes };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.dizibak.base", DEFAULT_BASE, "mirrorUrl");
      const playerHost = await resolveBaseUrl(
        "urls.series.dizibak.player",
        "https://player.dizibak.net",
      );

      if (streamId.startsWith("ep:")) {
        return finalizeStreams(
          await resolveDizibakPlayer(decodeURIComponent(streamId.slice(3)), base, playerHost),
        );
      }

      const parts = streamId.split(":");
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, "series");
      if (!identity) return { streams: [] };
      const sTarget = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      const sr = await this.search!(identity.title, {}, 1);
      const best = pickBestCandidate(
        sr.items.map((x) => ({ title: x.title, nativeId: x.nativeId })),
        identity.title,
        identity.originalTitle,
      );
      if (!best) return { streams: [] };

      const detail = await this.getDetails!(best.nativeId);
      const ep = detail.episodes.find((x) => x.season === sTarget && x.episode === eTarget);
      if (!ep) return { streams: [] };

      return finalizeStreams(
        await resolveDizibakPlayer(decodeURIComponent(ep.streamId.slice(3)), base, playerHost),
      );
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
