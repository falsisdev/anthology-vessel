import { crypto, definePlugin, html } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
  StreamCandidate,
  SubtitleTrack,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchJson,
  fetchText,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import { pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import { createStream, sortStreamsByQuality } from "./shared/core/quality.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  extractYear,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://liderfilmizle.vip";

interface LiderSearchItem {
  title?: string;
  original_title?: string;
  slug?: string;
  type?: string;
  poster?: string;
  year?: number | string;
}

interface LiderSearchResponse {
  results?: LiderSearchItem[];
}

interface LiderEmbeddedSource {
  id?: string;
  url?: string;
}

function parseCatalogCards(
  rawHtml: string,
  base: string,
  kind: "movie" | "series",
): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();
  const selector = kind === "series" ? "a[href*='/dizi/']" : "a.movie-card[href]";

  for (const card of doc.select(selector)) {
    const href = card.attr("href");
    if (!href) continue;
    const cleanPath = href.replace(/^\//, "");
    if (!cleanPath || cleanPath.startsWith("kesfet") || cleanPath === "diziler") continue;

    const slug =
      kind === "series"
        ? cleanPath.replace(/^dizi\//, "").split("/")[0] ?? ""
        : cleanPath.split("/")[0] ?? "";
    if (!slug || seen.has(slug)) continue;

    const img = card.selectOne("img");
    const rawTitle =
      img?.attr("alt") || card.selectOne("h2, h3, .title")?.text() || card.text();
    const title = decodeHtmlEntities(rawTitle).trim();
    if (!title) continue;

    seen.add(slug);
    const posterRaw = img?.attr("data-src") || img?.attr("src");
    out.push({
      nativeId: `${kind}:${slug}`,
      type: kind,
      title,
      year: extractYear(title),
      poster: posterRaw ? absoluteUrl(base, posterRaw) : undefined,
    });
  }
  return out;
}

async function resolveLiderSource(
  sourceUrl: string,
  pageUrl: string,
): Promise<StreamCandidate[]> {
  if (!sourceUrl || sourceUrl.includes("youtube.com")) return [];
  const fullSourceUrl = absoluteUrl(pageUrl, sourceUrl);

  if (fullSourceUrl.includes("/vod/")) {
    const vHtml = await fetchText(fullSourceUrl, {
      timeoutMs: 12_000,
      headers: buildHeaders(pageUrl),
    });
    if (!vHtml) return [];
    const srcMatch =
      /file:\s*["'](\/player\/stream\.php\?url=[^"']+)["']/i.exec(vHtml) ??
      /sources:\s*\[\s*\{\s*file:\s*["']([^"']+)["']/i.exec(vHtml);
    if (!srcMatch?.[1]) return [];

    const streamPath = srcMatch[1].replace(/\\/g, "");
    const streamUrl = absoluteUrl(fullSourceUrl, streamPath);
    const subs: SubtitleTrack[] = [];
    const trackRe =
      /file:\s*["']([^"']+\.vtt[^"']*)["']\s*,\s*label:\s*["']([^"']+)["']/gi;
    let tm: RegExpExecArray | null;
    while ((tm = trackRe.exec(vHtml)) !== null) {
      const subUrl = tm[1]?.replace(/\\/g, "") ?? "";
      const label = tm[2] ?? "Türkçe";
      if (!subUrl) continue;
      const lang =
        label.toLowerCase().includes("ing") || label.toLowerCase().includes("eng")
          ? "en"
          : "tr";
      subs.push({
        id: `${lang}_${subs.length}`,
        source: { kind: "url", url: subUrl, headers: { Referer: fullSourceUrl } },
        lang,
        label,
        format: "vtt",
        isDefault: lang === "tr",
      });
    }

    const playUrl = streamUrl.includes("#") ? streamUrl : `${streamUrl}#.m3u8`;
    return [
      createStream({
        url: playUrl,
        kind: "hls",
        quality: "1080p",
        label: "LiderFilm • 1080p HLS (TR / Dual)",
        headers: buildHeaders(fullSourceUrl),
        subtitles: subs.length > 0 ? subs : undefined,
      }),
    ];
  }

  // Embed player (/embed-...)
  const pHtml = await fetchText(fullSourceUrl, {
    timeoutMs: 12_000,
    headers: buildHeaders(pageUrl),
  });
  if (!pHtml) return [];
  const innerUrlRaw = html.parse(pHtml).selectOne("iframe[src]")?.attr("src");
  if (!innerUrlRaw) return [];
  const innerUrl = absoluteUrl(fullSourceUrl, innerUrlRaw);
  const innerHtml = await fetchText(innerUrl, {
    timeoutMs: 12_000,
    headers: buildHeaders(fullSourceUrl),
  });
  if (!innerHtml) return [];

  const dlMatch = /fetch\(['"](\/dl\?[^'"]+)['"]\)/.exec(innerHtml);
  if (!dlMatch?.[1]) return [];
  const dlUrl = absoluteUrl(innerUrl, dlMatch[1]);
  const innerOrigin = new URL(innerUrl).origin;
  const dlData = await fetchJson<{ url?: string }>(dlUrl, {
    timeoutMs: 12_000,
    headers: { Referer: innerUrl, Origin: innerOrigin },
  });
  if (!dlData?.url) return [];

  const playUrl = dlData.url.includes("#") ? dlData.url : `${dlData.url}#.m3u8`;
  return [
    createStream({
      url: playUrl,
      kind: "hls",
      quality: "1080p",
      label: "LiderFilm • Embed 1080p HLS",
      headers: { Referer: `${innerOrigin}/` },
    }),
  ];
}

async function extractPageStreams(pageUrl: string): Promise<StreamCandidate[]> {
  const rawHtml = await fetchText(pageUrl, {
    timeoutMs: 12_000,
    headers: buildHeaders(pageUrl),
  });
  if (!rawHtml) return [];
  const vsMatch = /window\._vs\s*=\s*['"]([^'"]+)['"]/.exec(rawHtml);
  if (!vsMatch?.[1]) return [];

  let sources: LiderEmbeddedSource[] = [];
  try {
    sources = JSON.parse(crypto.base64Decode(vsMatch[1])) as LiderEmbeddedSource[];
  } catch {
    return [];
  }

  const out: StreamCandidate[] = [];
  for (const src of sources) {
    if (!src.url || src.id === "trailer") continue;
    out.push(...(await resolveLiderSource(src.url, pageUrl)));
  }
  return out;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.liderfilmizle.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const [moviesHtml, seriesHtml] = await Promise.all([
        fetchText(`${base}/kesfet/filmler?sayfa=1`, { headers: buildHeaders(`${base}/`) }),
        fetchText(`${base}/diziler?sayfa=1`, { headers: buildHeaders(`${base}/`) }),
      ]);
      const movieItems = moviesHtml ? parseCatalogCards(moviesHtml, base, "movie") : [];
      const seriesItems = seriesHtml ? parseCatalogCards(seriesHtml, base, "series") : [];

      const sections: HomeFeed["sections"] = [
        { id: "movies", title: "Keşfet: Filmler", layout: "poster" as const, items: movieItems },
        { id: "series", title: "Popüler Diziler", layout: "poster" as const, items: seriesItems },
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
        "urls.movies.liderfilmizle.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const data = await fetchJson<LiderSearchResponse>(
        `${base}/api/search.php?q=${encodeURIComponent(query.trim())}`,
        { headers: buildHeaders(`${base}/`) },
      );
      const items: MediaSummary[] = (data?.results ?? [])
        .filter((r) => Boolean(r.slug))
        .map((r) => {
          const kind: "movie" | "series" = r.type === "series" ? "series" : "movie";
          return {
            nativeId: `${kind}:${r.slug}`,
            type: kind,
            title: decodeHtmlEntities(r.title || r.original_title || r.slug || ""),
            year: extractYear(String(r.year ?? "")),
            poster: r.poster ? absoluteUrl(base, r.poster) : undefined,
          };
        });
      return { items, hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl(
      "urls.movies.liderfilmizle.base",
      DEFAULT_BASE,
      "mirrorUrl",
    );
    const isSeries = nativeId.startsWith("series:");
    const slug = nativeId.replace(/^(?:movie|series|tv):/, "");
    const pageUrl = isSeries ? `${base}/dizi/${slug}` : `${base}/${slug}`;
    const rawHtml = await fetchText(pageUrl, { headers: buildHeaders(`${base}/`) });
    if (!rawHtml) {
      throw new Error(`LiderFilm içerik bulunamadı: ${slug}`);
    }

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(
      doc.selectOne("h1")?.text() ||
        doc.selectOne("title")?.text().split("-")[0] ||
        slug,
    ).trim();
    const poster =
      doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    const synopsis =
      doc.selectOne('meta[name="description"]')?.attr("content") ?? undefined;

    if (!isSeries) {
      return {
        nativeId,
        type: "movie",
        title,
        year: extractYear(title),
        poster,
        backdrop: poster,
        synopsis,
        episodes: [{ streamId: `movie:${slug}`, season: 1, episode: 1, title }],
      };
    }

    const episodes: Episode[] = [];
    const seen = new Set<string>();
    const epRe = new RegExp(`/dizi/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sezon-(\\d+)/bolum-(\\d+)`, "gi");
    let em: RegExpExecArray | null;
    while ((em = epRe.exec(rawHtml)) !== null) {
      const sN = Number.parseInt(em[1] ?? "1", 10);
      const eN = Number.parseInt(em[2] ?? "1", 10);
      const key = `${sN}:${eN}`;
      if (seen.has(key)) continue;
      seen.add(key);
      episodes.push({
        streamId: `series:${slug}:${sN}:${eN}`,
        season: sN,
        episode: eN,
        title: `${sN}. Sezon ${eN}. Bölüm`,
      });
    }
    if (episodes.length === 0) {
      episodes.push({
        streamId: `series:${slug}:1:1`,
        season: 1,
        episode: 1,
        title: "1. Sezon 1. Bölüm",
      });
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);

    const seasonNums = Array.from(new Set(episodes.map((e) => e.season)));
    const seasons: SeasonSummary[] = seasonNums.map((n) => ({
      id: String(n),
      season: n,
      title: `${n}. Sezon`,
      episodeCount: episodes.filter((e) => e.season === n).length,
    }));

    return {
      nativeId,
      type: "series",
      title,
      poster,
      backdrop: poster,
      synopsis,
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.liderfilmizle.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const parts = streamId.split(":");
      if (parts[0] === "movie" && parts[1]) {
        return { streams: sortStreamsByQuality(await extractPageStreams(`${base}/${parts[1]}`)) };
      }
      if (parts[0] === "series" && parts[1]) {
        const s = parts[2] ?? "1";
        const e = parts[3] ?? "1";
        return {
          streams: sortStreamsByQuality(
            await extractPageStreams(`${base}/dizi/${parts[1]}/sezon-${s}/bolum-${e}`),
          ),
        };
      }

      const typeHint = parts[3] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };

      const queries = [identity.title, identity.originalTitle].filter(Boolean);
      for (const q of queries) {
        const data = await fetchJson<LiderSearchResponse>(
          `${base}/api/search.php?q=${encodeURIComponent(q)}`,
          { headers: buildHeaders(`${base}/`) },
        );
        const candidates = (data?.results ?? [])
          .filter((r) => Boolean(r.slug))
          .map((r) => ({
            title: r.title ?? "",
            altTitle: r.original_title,
            year: extractYear(String(r.year ?? "")),
            slug: r.slug!,
            type: r.type === "series" ? "series" : "movie",
          }));
        const filtered = candidates.filter((c) => c.type === identity.mediaType);
        const best = pickBestCandidate(
          filtered.length > 0 ? filtered : candidates,
          identity.title,
          identity.originalTitle,
          identity.year,
        );
        if (best) {
          const targetUrl =
            best.type === "series"
              ? `${base}/dizi/${best.slug}/sezon-${parts[1] ?? "1"}/bolum-${parts[2] ?? "1"}`
              : `${base}/${best.slug}`;
          return { streams: sortStreamsByQuality(await extractPageStreams(targetUrl)) };
        }
      }
      return { streams: [] };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
