import { definePlugin } from "vessel";
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
import { buildHeaders, fetchJson, fetchText, rethrowIfDomainBlocked } from "./shared/core/http.ts";
import { finalizeStreams, pickBestCandidate } from "./shared/core/plugin-helpers.ts";
import { createStream } from "./shared/core/quality.ts";
import { decodeHtmlEntities, extractYear, ultraClean } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://puhutv.com";
const DYG_API = "https://dygvideo.dygdigital.com/api/video_info";

interface PuhuRawItem {
  display_name?: string;
  name?: string;
  type?: string;
  image?: string;
  image_vertical_mobile?: string;
  to_watch_asset_slug?: string;
  content_slug?: string;
  meta?: { slug?: string; productionDate?: string; position?: number };
}

interface PuhuCatalogEntry {
  title: string;
  detaySlug: string;
  type: "movie" | "series";
  poster?: string;
  year?: number;
}

interface PuhuNextData {
  props?: {
    pageProps?: {
      data?: { data?: { container_items?: Array<{ items?: PuhuRawItem[]; titles?: PuhuRawItem[] }> }; container_items?: Array<{ items?: PuhuRawItem[]; titles?: PuhuRawItem[] }> };
      details?: { data?: { display_name?: string; name?: string; image?: string; image_vertical_mobile?: string; video_id?: string; description?: string } };
      movieAssets?: { data?: { display_name?: string; name?: string; image?: string; image_vertical_mobile?: string; video_id?: string; description?: string } };
      episodeData?: { data?: Array<{ name?: string; episodes?: Array<{ display_name?: string; name?: string; slug?: string; video_id?: string; image?: string; meta?: { position?: number } }> }> | { name?: string; episodes?: Array<{ display_name?: string; name?: string; slug?: string; video_id?: string; image?: string; meta?: { position?: number } }> } };
    };
  };
}

interface DygVideoInfo {
  data?: {
    flavors?: Record<string, string>;
    tracks?: Array<{ url?: string; file?: string; src?: string; lang?: string; language?: string; label?: string }>;
  };
}

function parseNextPageProps(rawHtml: string) {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i.exec(rawHtml);
  if (!m?.[1]) return null;
  try {
    return (JSON.parse(m[1]) as PuhuNextData).props?.pageProps ?? null;
  } catch {
    return null;
  }
}

async function fetchPuhuCatalog(base: string, slug: "yerli-diziler" | "filmler"): Promise<PuhuCatalogEntry[]> {
  const rawHtml = await fetchText(`${base}/${slug}`, {
    timeoutMs: 12_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!rawHtml) return [];
  const pp = parseNextPageProps(rawHtml);
  const root = pp?.data?.data ?? pp?.data;
  const containers = root?.container_items ?? [];

  const out: PuhuCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    for (const raw of [...(container.items ?? []), ...(container.titles ?? [])]) {
      const title = decodeHtmlEntities(raw.display_name || raw.name || "").trim();
      const detaySlug = raw.meta?.slug || raw.content_slug || raw.to_watch_asset_slug || "";
      if (!title || !detaySlug || seen.has(detaySlug)) continue;
      seen.add(detaySlug);
      out.push({
        title,
        detaySlug,
        type: raw.type === "title_movie" || slug === "filmler" ? "movie" : "series",
        poster: raw.image_vertical_mobile || raw.image || undefined,
        year: extractYear(raw.meta?.productionDate),
      });
    }
  }
  return out;
}

function toSummary(entry: PuhuCatalogEntry): MediaSummary {
  return {
    nativeId: `${entry.type}:${encodeURIComponent(entry.detaySlug)}`,
    type: entry.type,
    title: entry.title,
    year: entry.year,
    poster: entry.poster,
  };
}

async function resolveDygStreams(videoId: string, label: string, base: string): Promise<StreamCandidate[]> {
  const url = `${DYG_API}?akamai=true&PublisherId=29&ReferenceId=${encodeURIComponent(videoId)}&SecretKey=NtvApiSecret2014*`;
  const data = await fetchJson<DygVideoInfo>(url, { timeoutMs: 12_000 });
  const flavors = data?.data?.flavors;
  if (!flavors) return [];

  const subtitles: SubtitleTrack[] = [];
  for (const t of data?.data?.tracks ?? []) {
    const subUrl = t.url || t.file || t.src;
    if (!subUrl) continue;
    const lang = (t.lang || t.language || "tr").toLowerCase().slice(0, 2);
    subtitles.push({
      id: `sub_${subtitles.length}`,
      source: { kind: "url", url: subUrl, headers: buildHeaders(`${base}/`) },
      lang,
      label: t.label || (lang === "en" ? "English" : "Türkçe"),
      format: "vtt",
      isDefault: lang === "tr",
    });
  }

  const out: StreamCandidate[] = [];
  const headers = buildHeaders(`${base}/`);
  if (typeof flavors["hls"] === "string" && flavors["hls"]) {
    out.push(
      createStream({
        url: flavors["hls"],
        kind: "hls",
        quality: "1080p",
        label: `PuhuTV • ${label} [HLS]`,
        language: "tr",
        headers,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
      }),
    );
  }
  for (const val of Object.values(flavors)) {
    if (typeof val === "string" && /\.mp4(?:\?|$)/i.test(val)) {
      out.push(
        createStream({
          url: val,
          kind: "mp4",
          quality: "1080p",
          label: `PuhuTV • ${label} [MP4]`,
          language: "tr",
          headers,
          subtitles: subtitles.length > 0 ? subtitles : undefined,
        }),
      );
    }
  }
  return out;
}

async function fetchShowOrMovieProps(base: string, detaySlug: string) {
  const clean = decodeURIComponent(detaySlug).replace(/^\/+/, "");
  const cands = [clean, `${clean}-detay`, `${clean}-1-sezon-bolumleri`];
  for (const path of cands) {
    const target = path.startsWith("http") ? path : `${base}/${path}`;
    const rawHtml = await fetchText(target, { timeoutMs: 12_000, headers: buildHeaders(`${base}/`) });
    if (!rawHtml) continue;
    const pp = parseNextPageProps(rawHtml);
    const meta = pp?.details?.data ?? pp?.movieAssets?.data;
    if (meta) return { meta, epData: pp?.episodeData?.data };
  }
  return null;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.puhutv.base", DEFAULT_BASE, "mirrorUrl");
      const [series, movies] = await Promise.all([
        fetchPuhuCatalog(base, "yerli-diziler"),
        fetchPuhuCatalog(base, "filmler"),
      ]);
      const sections: HomeFeed["sections"] = [
        { id: "series", title: "Yerli Diziler", layout: "poster" as const, items: series.map(toSummary) },
        { id: "movies", title: "Türk Filmleri", layout: "poster" as const, items: movies.map(toSummary) },
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
      const base = await resolveBaseUrl("urls.series.puhutv.base", DEFAULT_BASE, "mirrorUrl");
      const [series, movies] = await Promise.all([
        fetchPuhuCatalog(base, "yerli-diziler"),
        fetchPuhuCatalog(base, "filmler"),
      ]);
      const qClean = ultraClean(query);
      const all = [...series, ...movies].filter((it) => ultraClean(it.title).includes(qClean));
      return { items: all.slice(0, 30).map(toSummary), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.puhutv.base", DEFAULT_BASE, "mirrorUrl");
    const isMovie = nativeId.startsWith("movie:");
    const detaySlug = decodeURIComponent(nativeId.replace(/^(?:movie|series):/, ""));
    const info = await fetchShowOrMovieProps(base, detaySlug);
    if (!info) throw new Error(`PuhuTV içerik bulunamadı: ${detaySlug}`);

    const title = decodeHtmlEntities(info.meta.display_name || info.meta.name || detaySlug).trim();
    const poster = info.meta.image_vertical_mobile || info.meta.image || undefined;

    if (isMovie && info.meta.video_id) {
      return {
        nativeId,
        type: "movie",
        title,
        poster,
        backdrop: info.meta.image || poster,
        synopsis: info.meta.description,
        episodes: [{ streamId: `vid:${info.meta.video_id}:${encodeURIComponent(title)}`, season: 1, episode: 1, title }],
      };
    }

    const epBuckets = Array.isArray(info.epData) ? info.epData : info.epData ? [info.epData] : [];
    const episodes: Episode[] = [];
    const seasons: SeasonSummary[] = [];

    for (let sIdx = 0; sIdx < epBuckets.length; sIdx++) {
      const sNum = sIdx + 1;
      const bucket = epBuckets[sIdx]!;
      const rawEps = bucket.episodes ?? [];
      for (let eIdx = 0; eIdx < rawEps.length; eIdx++) {
        const ep = rawEps[eIdx]!;
        if (!ep.video_id) continue;
        const epNum = ep.meta?.position ?? eIdx + 1;
        const epTitle = decodeHtmlEntities(ep.display_name || ep.name || `${epNum}. Bölüm`);
        episodes.push({
          streamId: `vid:${ep.video_id}:${encodeURIComponent(`${title} ${epNum}. Bölüm`)}`,
          season: sNum,
          episode: epNum,
          title: epTitle,
          thumbnail: ep.image || undefined,
        });
      }
      if (rawEps.length > 0) {
        seasons.push({
          id: String(sNum),
          season: sNum,
          title: bucket.name || `${sNum}. Sezon`,
          episodeCount: rawEps.length,
        });
      }
    }

    return {
      nativeId,
      type: "series",
      title,
      poster,
      backdrop: info.meta.image || poster,
      synopsis: info.meta.description,
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.puhutv.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("vid:")) {
        const parts = streamId.split(":");
        const vid = parts[1] ?? "";
        const label = decodeURIComponent(parts.slice(2).join(":") || "Bölüm");
        return finalizeStreams(await resolveDygStreams(vid, label, base));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };

      const catalog = await fetchPuhuCatalog(base, typeHint === "movie" ? "filmler" : "yerli-diziler");
      const best = pickBestCandidate(catalog, identity.title, identity.originalTitle, identity.year);
      if (!best) return { streams: [] };

      const info = await fetchShowOrMovieProps(base, best.detaySlug);
      if (!info) return { streams: [] };

      if (typeHint === "movie" && info.meta.video_id) {
        return finalizeStreams(await resolveDygStreams(info.meta.video_id, identity.title, base));
      }

      const targetS = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const targetE = Number.parseInt(parts[2] ?? "1", 10) || 1;
      const buckets = Array.isArray(info.epData) ? info.epData : info.epData ? [info.epData] : [];
      const bucket = buckets[targetS - 1] ?? buckets[0];
      const ep = bucket?.episodes?.find((x, i) => (x.meta?.position ?? i + 1) === targetE);
      if (!ep?.video_id) return { streams: [] };

      return finalizeStreams(await resolveDygStreams(ep.video_id, `${identity.title} ${targetE}. Bölüm`, base));
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
