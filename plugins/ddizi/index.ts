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
  ultraClean,
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

function extractDdiziPoster(rawHtml: string, base: string): string | undefined {
  const doc = html.parse(rawHtml);
  const posterImg = doc.selectOne(
    ".dizi-resmi img, .img-back-cat img, .dizi-boxpost-cat img, .dizi-boxpost img, img[data-src*='diziresimleri'], img[src*='diziresimleri']",
  );
  const rawPoster =
    doc.selectOne('meta[property="og:image"]')?.attr("content") ||
    posterImg?.attr("data-src") ||
    posterImg?.attr("src");
  return rawPoster && !rawPoster.startsWith("data:")
    ? absoluteUrl(base, rawPoster)
    : undefined;
}

async function hydrateDdiziPosters(
  items: MediaSummary[],
  base: string,
  limit = 24,
): Promise<void> {
  const missing = items.filter((it) => !it.poster && it.nativeId.startsWith("series:")).slice(0, limit);
  const BATCH = 6;
  for (let i = 0; i < missing.length; i += BATCH) {
    await Promise.all(
      missing.slice(i, i + BATCH).map(async (item) => {
        const slug = item.nativeId.replace(/^series:/, "");
        const raw = await fetchText(`${base}/diziler/${slug}`, {
          timeoutMs: 4_500,
          headers: buildHeaders(`${base}/`),
        });
        if (!raw) return;
        const poster = extractDdiziPoster(raw, base);
        if (poster) item.poster = poster;
      }),
    );
  }
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.ddizi.base", DEFAULT_BASE, "mirrorUrl");
      const htmlText = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      if (!htmlText) return { sections: [] };

      const latestEps = dedupeMediaSummaries(parseDdiziBoxPosts(htmlText, base)).slice(0, 32);
      const boxPosterByKey = new Map<string, string>();
      for (const ep of latestEps) {
        if (!ep.poster) continue;
        const baseName = ep.title
          .replace(/\s+\d+\.?\s*b[oö]l[uü]m.*$/i, "")
          .replace(/\s+\d{1,2}\s+(?:ocak|[sş]ubat|mart|nisan|may[ıi]s|haziran|temmuz|a[ğg]ustos|eyl[üu]l|ekim|kas[ıi]m|aral[ıi]k)\s+\d{4}.*$/i, "")
          .trim();
        const key = ultraClean(baseName);
        if (key && !boxPosterByKey.has(key)) {
          boxPosterByKey.set(key, ep.poster);
        }
      }

      let shows = dedupeMediaSummaries(parseDdiziLinks(htmlText, base)).slice(0, 36);
      for (const show of shows) {
        if (!show.poster) {
          const key = ultraClean(show.title);
          const matched = boxPosterByKey.get(key);
          if (matched) show.poster = matched;
        }
      }
      await hydrateDdiziPosters(shows, base, 24);
      shows = shows.filter((s) => Boolean(s.poster));

      const sections: HomeFeed["sections"] = [
        { id: "series", title: "Yerli Diziler", layout: "poster" as const, items: shows },
        { id: "latest", title: "Son Eklenen Bölümler", layout: "poster" as const, items: latestEps },
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
      const qTrim = query.trim();
      const qClean = ultraClean(qTrim);
      const res = await postForm(
        `${base}/arama/`,
        { arama: qTrim },
        { timeoutMs: 10_000, headers: buildHeaders(`${base}/`) },
      );
      const body = res && res.status < 400 ? res.text() : "";
      let shows = body
        ? parseDdiziLinks(body, base).filter(
            (m) => ultraClean(m.title).includes(qClean) || ultraClean(m.nativeId).includes(qClean),
          )
        : [];

      if (shows.length === 0) {
        const archHtml = await fetchText(`${base}/eski.diziler`, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        });
        if (archHtml) {
          shows = parseDdiziLinks(archHtml, base).filter(
            (m) => ultraClean(m.title).includes(qClean) || ultraClean(m.nativeId).includes(qClean),
          );
        }
      }

      if (shows.length > 0) {
        const boxMatches = body ? parseDdiziBoxPosts(body, base) : [];
        for (const show of shows) {
          if (!show.poster) {
            const sk = ultraClean(show.title);
            const hit = boxMatches.find((b) => b.poster && ultraClean(b.title).includes(sk));
            if (hit?.poster) show.poster = hit.poster;
          }
        }
        await hydrateDdiziPosters(shows, base, 12);
        return { items: dedupeMediaSummaries(shows).slice(0, 30), hasMore: false };
      }

      const boxItems = body
        ? parseDdiziBoxPosts(body, base).filter(
            (m) => ultraClean(m.title).includes(qClean) || ultraClean(m.nativeId).includes(qClean),
          )
        : [];
      return { items: dedupeMediaSummaries(boxItems).slice(0, 30), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.ddizi.base", DEFAULT_BASE, "mirrorUrl");
    let resolvedSeriesId = nativeId.startsWith("series:") ? nativeId : "";
    let fallbackEpTitle = "DDizi Bölüm";
    let fallbackEpUrl = "";
    let fallbackEpHtml: string | null = null;

    if (nativeId.startsWith("ep:")) {
      fallbackEpUrl = decodeURIComponent(nativeId.slice(3));
      fallbackEpHtml = await fetchText(fallbackEpUrl, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      if (fallbackEpHtml) {
        const epDoc = html.parse(fallbackEpHtml);
        fallbackEpTitle = decodeHtmlEntities(
          epDoc.selectOne("h1, h2")?.text() ||
            epDoc.selectOne("title")?.text().replace(/\s*(?:Son\s*B[oö]l[uü]m.*|\|\s*Ddizi.*)$/i, "") ||
            "DDizi Bölüm",
        ).trim();
        const activeParentHref =
          epDoc.selectOne('h2 a.active[href*="/diziler/"], a.active[href*="/diziler/"]')?.attr("href");
        const epBaseKey = ultraClean(
          fallbackEpTitle.replace(/\s+\d+\.?\s*b[oö]l[uü]m.*$/i, ""),
        );
        const matchingHref =
          activeParentHref ??
          epDoc
            .select('a[href*="/diziler/"]')
            .find((a) => {
              const t = ultraClean(a.text() || a.attr("title") || "");
              return Boolean(t && epBaseKey && (epBaseKey.includes(t) || t.includes(epBaseKey)));
            })
            ?.attr("href");
        if (matchingHref) {
          const fullShow = absoluteUrl(base, matchingHref).replace(/\/+$/, "");
          const slugPart = fullShow.split("/diziler/")[1]?.replace(/^\/+|\/+$/g, "") ?? "";
          if (slugPart) resolvedSeriesId = `series:${slugPart}`;
        }
      }
    }

    if (!resolvedSeriesId) {
      const poster = fallbackEpHtml ? extractDdiziPoster(fallbackEpHtml, base) : undefined;
      const parsed = parseSeasonEpisode(fallbackEpTitle, 1);
      return {
        nativeId,
        type: "series",
        title: fallbackEpTitle,
        poster,
        backdrop: poster,
        episodes: [
          {
            streamId: nativeId,
            season: parsed?.season ?? 1,
            episode: parsed?.episode ?? 1,
            title: fallbackEpTitle,
          },
        ],
      };
    }

    const slug = resolvedSeriesId.replace(/^series:/, "");
    const showUrl = `${base}/diziler/${slug}`;
    const showHtml = await fetchText(showUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!showHtml) throw new Error(`DDizi dizisi bulunamadı: ${slug}`);

    const doc = html.parse(showHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1, h2")?.text().replace(/\s*son\s*b[oö]l[uü]m.*$/i, "") ||
        doc.selectOne("title")?.text().replace(/\s*(?:Son\s*B[oö]l[uü]m.*|\|\s*Ddizi.*)$/i, "") ||
        slug.split("/").pop()?.replace(/-\d*(?:son-bolum.*|izle.*)$/i, "").replace(/-/g, " ") ||
        slug,
    )
      .replace(/\s*Full\s*.*$/i, "")
      .trim();
    const poster = extractDdiziPoster(showHtml, base);

    const pageUrls: string[] = [];
    const seenPage = new Set<string>([showUrl.replace(/\/+$/, "")]);
    for (const pm of showHtml.matchAll(/href=["']([^"']*\/sayfa-\d+)["']/gi)) {
      const pUrl = absoluteUrl(base, pm[1]!).replace(/\/+$/, "");
      if (!seenPage.has(pUrl)) {
        seenPage.add(pUrl);
        pageUrls.push(pUrl);
        if (pageUrls.length >= 15) break;
      }
    }

    const pageHtmls: string[] = [showHtml];
    const BATCH = 6;
    for (let i = 0; i < pageUrls.length; i += BATCH) {
      const chunk = pageUrls.slice(i, i + BATCH);
      const fetched = await Promise.all(
        chunk.map((u) => fetchText(u, { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) })),
      );
      for (const h of fetched) {
        if (h) pageHtmls.push(h);
      }
    }

    const slugTail = (slug.split("/")[1] || slug).replace(/-\d*-?son-bolum.*$/i, "").replace(/-izle.*$/i, "");
    const baseSlugKey = ultraClean(slugTail);
    const titleKey = ultraClean(title);

    const episodes: Episode[] = [];
    const seen = new Set<string>();
    for (const pHtml of pageHtmls) {
      const pDoc = html.parse(pHtml);
      const boxLinks = pDoc.select('.dizi-boxpost-cat a[href*="/izle/"], .dizi-boxpost a[href*="/izle/"]');
      const candidates = boxLinks.length > 0 ? boxLinks : pDoc.select('a[href*="/izle/"]');
      for (const a of candidates) {
        const href = a.attr("href");
        if (!href) continue;
        const full = absoluteUrl(base, href);
        if (seen.has(full)) continue;
        const epTitle = decodeHtmlEntities(a.attr("title") || a.text())
          .replace(/\s+izle$/i, "")
          .replace(/\s+/g, " ")
          .trim();
        const epClean = ultraClean(`${full} ${epTitle}`);
        if (boxLinks.length === 0 && baseSlugKey && !epClean.includes(baseSlugKey) && titleKey && !epClean.includes(titleKey)) {
          continue;
        }
        seen.add(full);
        const parsed = parseSeasonEpisode(epTitle || full, 1);
        const epNum = parsed?.episode ?? episodes.length + 1;
        const sNum = parsed?.season ?? 1;
        const epImg = a.selectOne("img");
        const epThumbRaw = epImg?.attr("data-src") || epImg?.attr("src");
        episodes.push({
          streamId: `ep:${encodeURIComponent(full)}`,
          season: sNum,
          episode: epNum,
          title: epTitle || `${epNum}. Bölüm`,
          thumbnail:
            epThumbRaw && !epThumbRaw.startsWith("data:")
              ? absoluteUrl(base, epThumbRaw)
              : poster,
        });
      }
    }

    if (episodes.length === 0 && showHtml.includes("/player/oynat/")) {
      episodes.push({
        streamId: `ep:${encodeURIComponent(showUrl)}`,
        season: 1,
        episode: 1,
        title: title || "1. Bölüm",
        thumbnail: poster,
      });
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const seasons = Array.from(new Set(episodes.map((e) => e.season))).map((s) => ({
      id: String(s),
      season: s,
      title: `${s}. Sezon`,
      episodeCount: episodes.filter((e) => e.season === s).length,
    }));

    return {
      nativeId: resolvedSeriesId,
      type: "series",
      title,
      poster,
      backdrop: poster,
      seasons,
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
