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
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractDailymotion } from "./shared/extractors/video-hosts.ts";
import { searchOfficialYouTubeEpisode } from "./shared/extractors/youtube.ts";

const DEFAULT_BASE = "https://www.ddizi.tel";

function parseDdiziBoxPosts(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const box of doc.select(".dizi-boxpost, .dizi-boxpost-cat")) {
    const a = box.selectOne('a[href*="/izle/"], a[href*="/diziler/"], a[href]');
    const href = a?.attr("href");
    if (!href) continue;
    const full = absoluteUrl(base, href).replace(/\/+$/, "");
    if (seen.has(full)) continue;
    const img = box.selectOne("img");
    const rawTitle = a?.attr("title") || img?.attr("alt") || box.text();
    const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
    if (!title || title.length < 2) continue;
    seen.add(full);
    const rawPoster = img?.attr("data-src") || img?.attr("src");
    const poster =
      rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined;
    const isSeriesPage = full.includes("/diziler/");
    const slug = isSeriesPage ? full.split("/diziler/")[1] ?? full : full;
    out.push({
      nativeId: isSeriesPage ? `series:${slug}` : `ep:${encodeURIComponent(full)}`,
      type: "series",
      title,
      poster,
    });
  }
  return out;
}

function parseDdiziLinks(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select('a[href*="/diziler/"]')) {
    const href = a.attr("href");
    if (!href) continue;
    const full = absoluteUrl(base, href).replace(/\/+$/, "");
    const slug = full.split("/diziler/")[1]?.replace(/^\/+|\/+$/g, "") ?? "";
    const title = decodeHtmlEntities(a.attr("title") || a.text())
      .replace(/\s*son\s*b[oö]l[uü]m\s*izle\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!slug || seen.has(slug) || title.length < 2) continue;
    seen.add(slug);
    const img = a.selectOne("img");
    const rawPoster = img?.attr("data-src") || img?.attr("src");
    out.push({
      nativeId: `series:${slug}`,
      type: "series",
      title,
      poster:
        rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined,
    });
  }
  return out;
}

async function resolveDdiziEpisodeStreams(
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

  for (const ifr of doc.select("iframe[src]")) {
    const rawSrc = ifr.attr("src");
    if (!rawSrc) continue;
    const src = absoluteUrl(base, rawSrc);

    if (src.includes("/player/oynat/")) {
      const pHtml = await fetchText(src, {
        timeoutMs: 10_000,
        headers: buildHeaders(epUrl),
      });
      if (!pHtml) continue;
      const urls: string[] = [
        ...(pHtml.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/gi) ?? []),
        ...Array.from(
          pHtml.matchAll(/file\s*:\s*["'](https?:\\\/\\\/[^"']+|https?:[^"']+)["']/gi),
        ).map((m) => m[1]!.replace(/\\\//g, "/")),
      ];

      for (const candidateUrl of urls) {
        const vUrl = candidateUrl.trim();
        if (!vUrl || seen.has(vUrl)) continue;
        if (/preview\/|image\/|\.(?:svg|jpg|png)(?:\?|$)/i.test(vUrl)) continue;
        seen.add(vUrl);

        if (vUrl.includes("googlevideo")) {
          const dur = /[?&]dur=([0-9.]+)/.exec(vUrl)?.[1];
          if (dur && Number.parseFloat(dur) < 300) continue;
        }

        const kind = inferStreamKind(vUrl);
        const quality = vUrl.includes("720") || vUrl.includes("itag=22")
          ? "720p"
          : vUrl.includes("480")
            ? "480p"
            : vUrl.includes("360") || vUrl.includes("itag=18")
              ? "360p"
              : "1080p";
        const refHeaders: Record<string, string> = vUrl.includes("ciner.com.tr")
          ? buildHeaders("https://www.ciner.com.tr/")
          : vUrl.includes("yandex")
            ? buildHeaders("https://yadi.sk/")
            : vUrl.includes("twimg")
              ? { ...buildHeaders("https://twitter.com/"), Origin: "https://twitter.com" }
              : buildHeaders(src);

        streams.push(
          createStream({
            url: vUrl,
            kind,
            quality,
            label: `DDizi • ${quality} ${kind === "mp4" ? "MP4" : "HLS"}`,
            language: "tr",
            headers: refHeaders,
          }),
        );
      }
    } else if (src.includes("daily.php") || src.includes("dailymotion.com")) {
      streams.push(
        ...(await extractDailymotion(src, { sourceLabel: "DDizi", language: "tr" })),
      );
    }
  }
  return streams;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.ddizi.base", DEFAULT_BASE, "mirrorUrl");
      const htmlText = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const latestEps = htmlText ? dedupeMediaSummaries(parseDdiziBoxPosts(htmlText, base)).slice(0, 36) : [];
      const page2Html = await fetchText(`${base}/sayfa/2`, {
        timeoutMs: 6_000,
        headers: buildHeaders(`${base}/`),
      });
      const moreEps = page2Html
        ? dedupeMediaSummaries(parseDdiziBoxPosts(page2Html, base)).slice(0, 36)
        : [];
      const sections: HomeFeed["sections"] = [
        { id: "latest", title: "Son Eklenen Bölümler", layout: "poster" as const, items: latestEps },
        {
          id: "more",
          title: "Yerli Diziler",
          layout: "poster" as const,
          items: moreEps.filter((m) => Boolean(m.poster)),
        },
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
      const base = await resolveBaseUrl("urls.series.ddizi.base", DEFAULT_BASE, "mirrorUrl");
      const res = await postForm(
        `${base}/arama/`,
        { arama: query.trim() },
        { timeoutMs: 10_000, headers: buildHeaders(`${base}/`) },
      );
      if (!res || res.status >= 400) return { items: [], hasMore: false };
      const body = res.text();
      const shows = parseDdiziLinks(body, base);
      if (shows.length > 0) return { items: shows, hasMore: false };

      const doc = html.parse(body);
      const epItems: MediaSummary[] = [];
      for (const a of doc.select('a[href*="/izle/"]')) {
        const href = a.attr("href");
        const title = decodeHtmlEntities(a.text()).trim();
        if (!href || title.length < 3) continue;
        epItems.push({
          nativeId: `ep:${encodeURIComponent(absoluteUrl(base, href))}`,
          type: "series",
          title,
        });
      }
      return { items: dedupeMediaSummaries(epItems).slice(0, 30), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.ddizi.base", DEFAULT_BASE, "mirrorUrl");
    if (nativeId.startsWith("ep:")) {
      const epUrl = decodeURIComponent(nativeId.slice(3));
      const epHtml = await fetchText(epUrl, { headers: buildHeaders(`${base}/`) });
      const doc = epHtml ? html.parse(epHtml) : null;
      const cleanDocTitle = decodeHtmlEntities(
        doc?.selectOne("h1, h2")?.text() ||
          doc?.selectOne("title")?.text().replace(/\s*(?:Son\s*B[oö]l[uü]m.*|\|\s*Ddizi.*)$/i, "") ||
          "DDizi Bölüm",
      ).trim();
      const rawPoster =
        doc?.selectOne('meta[property="og:image"]')?.attr("content") ??
        doc?.selectOne(".dizi-resmi img, img[data-src*='diziresimleri'], img[src*='diziresimleri']")?.attr("data-src") ??
        doc?.selectOne(".dizi-resmi img, img[data-src*='diziresimleri'], img[src*='diziresimleri']")?.attr("src");
      const poster = rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined;
      const parsed = parseSeasonEpisode(cleanDocTitle, 1);
      return {
        nativeId,
        type: "series",
        title: cleanDocTitle,
        poster,
        backdrop: poster,
        episodes: [
          {
            streamId: nativeId,
            season: parsed?.season ?? 1,
            episode: parsed?.episode ?? 1,
            title: cleanDocTitle,
          },
        ],
      };
    }

    const slug = nativeId.replace(/^series:/, "");
    const showHtml = await fetchText(`${base}/diziler/${slug}`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!showHtml) throw new Error(`DDizi dizisi bulunamadı: ${slug}`);

    const doc = html.parse(showHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1, h2")?.text().replace(/\s*son\s*bölüm.*$/i, "") ||
        doc.selectOne("title")?.text().replace(/\s*(?:Son\s*B[oö]l[uü]m.*|\|\s*Ddizi.*)$/i, "") ||
        slug.split("/").pop()?.replace(/-\d*(?:son-bolum.*|izle.*)$/i, "").replace(/-/g, " ") ||
        slug,
    ).trim();
    const posterImg = doc.selectOne(
      ".dizi-resmi img, .img-back-cat img, .dizi-boxpost img, img[data-src*='diziresimleri'], img[src*='diziresimleri']",
    );
    const rawPoster =
      doc.selectOne('meta[property="og:image"]')?.attr("content") ||
      posterImg?.attr("data-src") ||
      posterImg?.attr("src");
    const poster =
      rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(base, rawPoster) : undefined;

    const episodes: Episode[] = [];
    const seen = new Set<string>();
    for (const a of doc.select('a[href*="/izle/"]')) {
      const href = a.attr("href");
      if (!href) continue;
      const full = absoluteUrl(base, href);
      if (seen.has(full)) continue;
      seen.add(full);
      const epTitle = decodeHtmlEntities(a.attr("title") || a.text()).trim();
      const parsed = parseSeasonEpisode(epTitle || full, 1);
      episodes.push({
        streamId: `ep:${encodeURIComponent(full)}`,
        season: parsed?.season ?? 1,
        episode: parsed?.episode ?? episodes.length + 1,
        title: epTitle || `${episodes.length + 1}. Bölüm`,
      });
    }
    if (episodes.length === 0 && showHtml.includes("/player/oynat/")) {
      episodes.push({
        streamId: `ep:${encodeURIComponent(`${base}/diziler/${slug}`)}`,
        season: 1,
        episode: 1,
        title: title || "1. Bölüm",
      });
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
      const base = await resolveBaseUrl("urls.series.ddizi.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("ep:")) {
        const epUrl = decodeURIComponent(streamId.slice(3));
        const direct = await resolveDdiziEpisodeStreams(epUrl, base);
        if (direct.length > 0) return finalizeStreams(direct);
        const slugTitle = epUrl.split("/").pop()?.replace(/-\d+-bolum.*/i, "").replace(/-/g, " ") ?? "";
        const parsed = parseSeasonEpisode(epUrl, 1);
        if (slugTitle) {
          const yt = await searchOfficialYouTubeEpisode(slugTitle, parsed?.episode ?? 1, "DDizi");
          return finalizeStreams(yt);
        }
        return { streams: [] };
      }

      const parts = streamId.split(":");
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, "series");
      if (!identity) return { streams: [] };
      const seasonNum = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const episodeNum = Number.parseInt(parts[2] ?? "1", 10) || 1;

      const sRes = await postForm(
        `${base}/arama/`,
        { arama: identity.title },
        { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
      );
      if (sRes && sRes.status < 400) {
        const body = sRes.text();
        const links = parseDdiziLinks(body, base).map((m) => ({
          title: m.title,
          slug: m.nativeId.replace(/^series:/, ""),
        }));
        const best = pickBestCandidate(links, identity.title, identity.originalTitle);
        if (best) {
          const detail = await this.getDetails!(`series:${best.slug}`);
          const ep = detail.episodes.find((x) => x.episode === episodeNum);
          if (ep) {
            const streams = await resolveDdiziEpisodeStreams(
              decodeURIComponent(ep.streamId.slice(3)),
              base,
            );
            if (streams.length > 0) return finalizeStreams(streams);
          }
        }
      }

      const ytFallback = await searchOfficialYouTubeEpisode(
        identity.title,
        episodeNum || seasonNum,
        "DDizi",
      );
      return finalizeStreams(ytFallback);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
