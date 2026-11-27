import { definePlugin, html } from "vessel";
import type {
  Episode,
  HomeFeed,
  HomeSection,
  MediaDetail,
  MediaSummary,
  SearchPage,
  StreamCandidate,
} from "vessel";
import { configString } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchJson,
  fetchText,
  postForm,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import {
  dedupeMediaSummaries,
  finalizeStreams,
  parseRouteId,
} from "./shared/core/plugin-helpers.ts";
import { createStream, inferStreamKind } from "./shared/core/quality.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  slugify,
  ultraClean,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { searchOfficialYouTubeEpisode } from "./shared/extractors/youtube.ts";

interface NetworkBases {
  now: string;
  show: string;
  kanald: string;
  atv: string;
  star: string;
  tv2: string;
}

async function getNetworkBases(): Promise<NetworkBases> {
  const [now, show, kanald, atv, star, tv2] = await Promise.all([
    configString("urls.series.anthology_diziler.now", "https://www.nowtv.com.tr"),
    configString("urls.series.anthology_diziler.show", "https://www.showtv.com.tr"),
    configString("urls.series.anthology_diziler.kanald", "https://www.kanald.com.tr"),
    configString("urls.series.anthology_diziler.atv", "https://www.atv.com.tr"),
    configString("urls.series.anthology_diziler.star", "https://www.startv.com.tr"),
    configString("urls.series.anthology_diziler.tv2", "https://www.tv2.com.tr"),
  ]);
  const normKanalD = kanald.replace(/\/+$/, "").replace("://kanald.com.tr", "://www.kanald.com.tr");
  return {
    now: now.replace(/\/+$/, ""),
    show: show.replace(/\/+$/, ""),
    kanald: normKanalD,
    atv: atv.replace(/\/+$/, ""),
    star: star.replace(/\/+$/, ""),
    tv2: tv2.replace(/\/+$/, ""),
  };
}

const JUNK_SLUGS = new Set([
  "gizlilik-politikasi",
  "dizi-izle",
  "program-izle",
  "now-haber",
  "yayin-akisi",
  "uygulama",
  "kurumsal",
  "canli-yayin",
  "iletisim",
  "duyurular",
  "hakkimizda",
  "kullanim-kosullari",
  "kvkk",
  "cerez-politikasi",
  "site-haritasi",
  "reklam",
  "canli-tv",
  "arsiv",
  "hesabim",
  "diziler",
  "programlar",
  "haberler",
  "fragmanlar",
  "tum-bolumler",
  "basvurular",
  "foto-galeri",
  "sinemalar",
  "eski-diziler",
  "yeni-diziler",
  "yerli-diziler",
]);

function titleFromSlug(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/* ==================== STREAM RESOLVERS ==================== */

async function resolveNowEpisode(
  nowBase: string,
  slug: string,
  ep: number,
): Promise<StreamCandidate[]> {
  const rawHtml = await fetchText(`${nowBase}/${slug}/bolum/${ep}`, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${nowBase}/`),
  });
  const vid = rawHtml
    ? /video_id["']?\s*[:=]\s*["']?(\d+)/i.exec(rawHtml)?.[1]
    : null;
  if (!vid) return [];

  const res = await postForm(
    `${nowBase}/ajax/stream`,
    { video_id: vid },
    {
      timeoutMs: 10_000,
      headers: {
        Referer: `${nowBase}/`,
        Origin: nowBase,
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!res || res.status >= 400) return [];
  try {
    const j = res.json<{ code?: number; video_url?: string }>();
    if (j.code !== 200 || !j.video_url) return [];
    return [
      createStream({
        url: j.video_url,
        kind: "hls",
        quality: "1080p",
        label: `NOW TV • ${titleFromSlug(slug)} • ${ep}. Bölüm (1080p HLS)`,
        language: "tr",
        headers: buildHeaders(`${nowBase}/`),
      }),
    ];
  } catch {
    return [];
  }
}

async function resolveShowEpisode(
  showBase: string,
  slugOrKey: string,
  season: number,
  episode: number,
  directPath?: string,
): Promise<StreamCandidate[]> {
  const cleanSlug = slugOrKey.split("/")[0] ?? slugOrKey;
  let targetHref = directPath ?? "";
  if (!targetHref) {
    const urlsToTry = [
      `${showBase}/dizi/tanitim/${slugOrKey}`,
      ...(slugOrKey !== cleanSlug ? [`${showBase}/dizi/tanitim/${cleanSlug}`] : []),
      `${showBase}/kanal/dizi/tum_bolumler/${cleanSlug}`,
    ];
    for (const listingUrl of urlsToTry) {
      const listing = await fetchText(listingUrl, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${showBase}/`),
      });
      if (!listing) continue;
      const doc = html.parse(listing);
      for (const a of doc.select('a[href*="/dizi/tum_bolumler/"]')) {
        const href = a.attr("href");
        if (!href) continue;
        const m = /-sezon-(\d+)-bolum-(\d+)-izle/i.exec(href) ?? /-(\d+)-bolum-izle/i.exec(href);
        if (m) {
          const epS = m[2] ? Number(m[1]) : 1;
          const epE = m[2] ? Number(m[2]) : Number(m[1]);
          if (epE === episode && (!m[2] || epS === season)) {
            targetHref = href;
            break;
          }
        }
      }
      if (targetHref) break;
    }
  }
  if (!targetHref) return [];

  const epHtml = await fetchText(absoluteUrl(showBase, targetHref), {
    timeoutMs: 10_000,
    headers: buildHeaders(`${showBase}/`),
  });
  if (!epHtml) return [];

  const hopeRaw = html.parse(epHtml).selectOne("[data-hope-video]")?.attr("data-hope-video");
  let m3u8 = "";
  if (hopeRaw) {
    try {
      const j = JSON.parse(decodeHtmlEntities(hopeRaw)) as {
        media?: { m3u8?: Array<string | { src?: string }> };
      };
      const first = j.media?.m3u8?.[0];
      m3u8 = typeof first === "string" ? first : first?.src ?? "";
    } catch {
      m3u8 = "";
    }
  }
  if (!m3u8) {
    m3u8 =
      /https:\/\/vmcdn\.ciner\.com\.tr\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i.exec(epHtml)?.[0] ?? "";
  }
  if (!m3u8) return [];

  return [
    createStream({
      url: m3u8,
      kind: "hls",
      quality: "1080p",
      label: `Show TV • ${episode}. Bölüm (1080p HLS)`,
      language: "tr",
      headers: buildHeaders(`${showBase}/`),
    }),
  ];
}

async function resolveKanalDEpisode(
  kanaldBase: string,
  slug: string,
  episode: number,
): Promise<StreamCandidate[]> {
  for (const url of [
    `${kanaldBase}/${slug}/bolumler/${slug}-${episode}-bolum`,
    `${kanaldBase}/${slug}/bolumler/${episode}-bolum`,
  ]) {
    const rawHtml = await fetchText(url, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${kanaldBase}/`),
    });
    if (!rawHtml) continue;
    const m = /https?:\/\/kanaldvod\.duhnet\.tv\/[^"'\s\\]+\.smil\/playlist\.m3u8[^"'\s\\]*/i.exec(
      rawHtml,
    );
    if (m?.[0]) {
      return [
        createStream({
          url: m[0],
          kind: "hls",
          quality: "1080p",
          label: `Kanal D • ${episode}. Bölüm (1080p HLS)`,
          language: "tr",
          headers: buildHeaders(`${kanaldBase}/`),
        }),
      ];
    }
  }
  return [];
}

async function resolveStarEpisode(
  starBase: string,
  slug: string,
  episode: number,
): Promise<StreamCandidate[]> {
  let rid: string | null = null;
  for (const url of [
    `${starBase}/dizi/${slug}/bolumler/${episode}-bolum`,
    `${starBase}/dizi/${slug}/bolumler/${episode}-bolum-final`,
    `${starBase}/${slug}/${episode}-bolum-izle`,
  ]) {
    const rawHtml = await fetchText(url, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${starBase}/`),
    });
    if (!rawHtml) continue;
    rid =
      /referenceId["']?\s*[:=]\s*["']?([a-f0-9]{24})/i.exec(rawHtml)?.[1] ??
      /\b([a-f0-9]{24})\b/.exec(rawHtml)?.[1] ??
      null;
    if (rid) break;
  }
  if (!rid) return [];

  const reference = `StarTv_${rid}`;
  const dyg = await fetchJson<{ data?: { flavors?: Record<string, string> } }>(
    `https://dygvideo.dygdigital.com/api/video_info?akamai=true&PublisherId=1&ReferenceId=${encodeURIComponent(reference)}&SecretKey=NtvApiSecret2014*`,
    { timeoutMs: 10_000 },
  );
  const flavors = dyg?.data?.flavors;
  if (!flavors) return [];

  const out: StreamCandidate[] = [];
  if (typeof flavors["hls"] === "string" && flavors["hls"]) {
    out.push(
      createStream({
        url: flavors["hls"],
        kind: "hls",
        quality: "1080p",
        label: `Star TV • ${episode}. Bölüm [HLS]`,
        language: "tr",
        headers: buildHeaders(`${starBase}/`),
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
          label: `Star TV • ${episode}. Bölüm [MP4]`,
          language: "tr",
          headers: buildHeaders(`${starBase}/`),
        }),
      );
    }
  }
  return out;
}

async function resolveAtvEpisode(
  atvBase: string,
  slug: string,
  episode: number,
): Promise<StreamCandidate[]> {
  const rawHtml = await fetchText(`${atvBase}/${slug}/${episode}-bolum/izle`, {
    timeoutMs: 8_000,
    headers: buildHeaders(`${atvBase}/`),
  });
  const vid = rawHtml
    ? /name="videoId"\s+value="([^"]+)"/.exec(rawHtml)?.[1] ??
      /videoId["']?\s*[:=]\s*["']?([a-f0-9-]{6,})/i.exec(rawHtml)?.[1]
    : null;
  if (!vid) return [];

  const gv = await fetchJson<{ video?: { VideoUrl?: string } }>(
    `https://videojs.tmgrup.com.tr/getvideo/0fe2a405-8afa-4238-b429-e5f96aec3a5c/${vid}`,
    { timeoutMs: 8_000, headers: buildHeaders(`${atvBase}/`) },
  );
  const videoUrl = gv?.video?.VideoUrl;
  if (!videoUrl?.startsWith("http")) return [];

  const kind = inferStreamKind(videoUrl, "hls");
  return [
    createStream({
      url: videoUrl,
      kind,
      quality: "1080p",
      label: `ATV • ${episode}. Bölüm (1080p)`,
      language: "tr",
      headers: buildHeaders(`${atvBase}/`),
    }),
  ];
}

async function resolveTv2Episode(
  tv2Base: string,
  slug: string,
  episode: number,
): Promise<StreamCandidate[]> {
  for (const prefix of ["diziler/arsiv", "diziler/guncel", "programlar/arsiv", "programlar/guncel"]) {
    const listHtml = await fetchText(`${tv2Base}/${prefix}/${slug}/bolumler`, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${tv2Base}/`),
    });
    if (!listHtml) continue;
    const epPath = listHtml.match(
      new RegExp(`/diziler/(?:arsiv|guncel)/${slug}/bolumler/${slug}-${episode}-bolum`, "i"),
    )?.[0] ?? listHtml.match(
      new RegExp(`/${prefix}/${slug}/bolumler/${slug}-${episode}-bolum`, "i"),
    )?.[0];
    if (!epPath) continue;

    const epHtml = await fetchText(`${tv2Base}${epPath}`, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${tv2Base}/`),
    });
    const cid = epHtml ? /data-id\s*=\s*"([a-zA-Z0-9]{20,})"/.exec(epHtml)?.[1] : null;
    if (!cid) continue;

    const media = await fetchJson<{
      Status?: string;
      Media?: { Link?: { SecurePath?: string; DefaultServiceUrl?: string } };
    }>(`${tv2Base}/action/media/${cid}`, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${tv2Base}/`),
    });
    const secure = media?.Media?.Link?.SecurePath;
    if (media?.Status !== "Success" || !secure) continue;
    const defaultSvc = (media.Media?.Link?.DefaultServiceUrl ?? "https://tv2vod.duhnet.tv").replace(/\/+$/, "");
    const full = secure.startsWith("http")
      ? secure
      : secure.startsWith("//")
        ? `https:${secure}`
        : `${defaultSvc}/${secure.replace(/^\/+/, "")}`;
    return [
      createStream({
        url: full,
        kind: "hls",
        quality: "1080p",
        label: `TV2 • ${episode}. Bölüm (1080p HLS)`,
        language: "tr",
        headers: buildHeaders(`${tv2Base}/`),
      }),
    ];
  }
  return [];
}

/* ==================== NETWORK CATALOG FETCHERS ==================== */

async function fetchNowHomeShows(nowBase: string): Promise<MediaSummary[]> {
  const rawHtml =
    (await fetchText(`${nowBase}/dizi-izle`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${nowBase}/`),
    })) ??
    (await fetchText(`${nowBase}/`, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${nowBase}/`),
    }));
  if (!rawHtml) return [];
  const doc = html.parse(rawHtml);
  const bySlug = new Map<string, MediaSummary>();

  for (const a of doc.select(`a[href^="${nowBase}/"]`)) {
    const href = a.attr("href") ?? "";
    const rel = href.slice(nowBase.length + 1);
    if (!rel || rel.includes("haber") || rel.includes("spor") || rel.includes("hava")) continue;
    const slug = rel.split("/")[0]?.split("?")[0]?.trim() ?? "";
    if (!slug || /^\d/.test(slug) || JUNK_SLUGS.has(slug.toLowerCase())) continue;
    const img = a.selectOne("img");
    const explicitTitle = decodeHtmlEntities(
      a.selectOne(".program-name strong, .program-name, h2, h3, .title")?.text() || "",
    )
      .replace(/\s+/g, " ")
      .trim();
    const altTitle = decodeHtmlEntities(img?.attr("alt") || "").replace(/\s+/g, " ").trim();
    const isShortCaption = explicitTitle.length >= 2 && explicitTitle.length <= 50;
    const rawTitle = isShortCaption
      ? explicitTitle
      : altTitle && altTitle.length <= 45 && !/[?!.]$/.test(altTitle)
        ? altTitle
        : titleFromSlug(slug);
    if (!rawTitle || rawTitle.length < 2 || /^ar[sş][iİı]v$/i.test(rawTitle)) continue;

    const rawPoster = img?.attr("data-src") || img?.attr("data-original") || img?.attr("src");
    const poster =
      rawPoster && !rawPoster.startsWith("data:")
        ? absoluteUrl(nowBase, rawPoster)
        : undefined;

    const prev = bySlug.get(slug);
    if (!prev) {
      if (!poster) continue;
      bySlug.set(slug, {
        nativeId: `now:${slug}`,
        type: "series",
        title: rawTitle,
        poster,
      });
    } else {
      if (!prev.poster && poster) prev.poster = poster;
      if (isShortCaption && explicitTitle.length < prev.title.length) {
        prev.title = explicitTitle;
      }
    }
  }
  const withPoster = Array.from(bySlug.values()).filter((x) => Boolean(x.poster));
  return dedupeMediaSummaries(withPoster.length > 0 ? withPoster : Array.from(bySlug.values())).slice(0, 36);
}

async function fetchShowHomeShows(showBase: string): Promise<MediaSummary[]> {
  const rawHtml = await fetchText(`${showBase}/diziler`, {
    timeoutMs: 9_000,
    headers: buildHeaders(`${showBase}/`),
  });
  if (!rawHtml) return [];
  const doc = html.parse(rawHtml);
  const bySlug = new Map<string, MediaSummary>();
  for (const a of doc.select('a[href*="/dizi/tanitim/"]')) {
    const href = a.attr("href") ?? "";
    const m = /\/dizi\/tanitim\/([a-z0-9-]+)(?:\/(\d+))?/i.exec(href);
    const slug = m?.[1]?.trim() ?? "";
    const showId = m?.[2]?.trim() ?? "";
    if (!slug || JUNK_SLUGS.has(slug)) continue;
    const key = showId ? `${slug}/${showId}` : slug;
    const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
    const title = decodeHtmlEntities(
      a.attr("title") || img?.attr("alt") || a.text() || titleFromSlug(slug),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length < 2) continue;
    const rawPoster = img?.attr("data-src") || img?.attr("src");
    const poster = rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(showBase, rawPoster) : undefined;
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { nativeId: `show:${key}`, type: "series", title, poster });
    } else if (!bySlug.get(slug)!.poster && poster) {
      bySlug.get(slug)!.poster = poster;
    }
  }
  return Array.from(bySlug.values()).slice(0, 36);
}

async function fetchKanalDHomeShows(kanaldBase: string): Promise<MediaSummary[]> {
  const rawHtml = await fetchText(`${kanaldBase}/diziler`, {
    timeoutMs: 9_000,
    headers: buildHeaders(`${kanaldBase}/`),
  });
  if (!rawHtml) return [];
  const doc = html.parse(rawHtml);
  const bySlug = new Map<string, MediaSummary>();
  for (const a of doc.select('a[href^="/"]')) {
    const href = a.attr("href") ?? "";
    const m = /^\/([a-z0-9-]+)\/?$/.exec(href);
    const slug = m?.[1] ?? "";
    if (!slug || JUNK_SLUGS.has(slug) || slug.includes("yayin") || slug.includes("haber")) continue;
    const img = a.selectOne("img");
    if (!img) continue;
    const title = decodeHtmlEntities(img.attr("alt") || a.attr("title") || a.text() || titleFromSlug(slug))
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length < 2) continue;
    const rawPoster = img.attr("data-src") || img.attr("src");
    const poster = rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(kanaldBase, rawPoster) : undefined;
    if (!bySlug.has(slug) && poster) {
      bySlug.set(slug, { nativeId: `kanald:${slug}`, type: "series", title, poster });
    }
  }
  return Array.from(bySlug.values()).slice(0, 36);
}

async function fetchStarHomeShows(starBase: string): Promise<MediaSummary[]> {
  const rawHtml = await fetchText(`${starBase}/dizi`, {
    timeoutMs: 9_000,
    headers: buildHeaders(`${starBase}/`),
  });
  if (!rawHtml) return [];
  const doc = html.parse(rawHtml);
  const bySlug = new Map<string, MediaSummary>();
  for (const a of doc.select('a[href^="/dizi/"]')) {
    const href = a.attr("href") ?? "";
    const m = /^\/dizi\/([a-z0-9-]+)\/?$/.exec(href);
    const slug = m?.[1] ?? "";
    if (!slug || JUNK_SLUGS.has(slug)) continue;
    const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
    const title = decodeHtmlEntities(a.attr("title") || img?.attr("alt") || a.text() || titleFromSlug(slug))
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length < 2) continue;
    const rawPoster = img?.attr("data-src") || img?.attr("src");
    const poster = rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(starBase, rawPoster) : undefined;
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { nativeId: `star:${slug}`, type: "series", title, poster });
    } else if (!bySlug.get(slug)!.poster && poster) {
      bySlug.get(slug)!.poster = poster;
    }
  }
  return Array.from(bySlug.values()).slice(0, 36);
}

async function fetchAtvHomeShows(atvBase: string): Promise<MediaSummary[]> {
  const rawHtml = await fetchText(`${atvBase}/diziler`, {
    timeoutMs: 9_000,
    headers: buildHeaders(`${atvBase}/`),
  });
  if (!rawHtml) return [];
  const doc = html.parse(rawHtml);
  const bySlug = new Map<string, MediaSummary>();
  for (const a of doc.select('a[href^="/"]')) {
    const href = a.attr("href") ?? "";
    const m = /^\/([a-z0-9-]+)\/?$/.exec(href);
    const slug = m?.[1] ?? "";
    if (!slug || JUNK_SLUGS.has(slug) || slug.includes("haber") || slug.includes("program")) continue;
    const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
    if (!img) continue;
    const title = decodeHtmlEntities(img.attr("alt") || a.attr("title") || a.text() || titleFromSlug(slug))
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length < 2) continue;
    const rawPoster = img.attr("data-src") || img.attr("src");
    const poster = rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(atvBase, rawPoster) : undefined;
    if (!bySlug.has(slug) && poster) {
      bySlug.set(slug, { nativeId: `atv:${slug}`, type: "series", title, poster });
    }
  }
  return Array.from(bySlug.values()).slice(0, 36);
}

async function fetchTv2HomeShows(tv2Base: string): Promise<MediaSummary[]> {
  const rawHtml = await fetchText(`${tv2Base}/diziler/arsiv`, {
    timeoutMs: 9_000,
    headers: buildHeaders(`${tv2Base}/`),
  });
  if (!rawHtml) return [];
  const doc = html.parse(rawHtml);
  const bySlug = new Map<string, MediaSummary>();
  for (const a of doc.select('a[href*="/diziler/"]')) {
    const href = a.attr("href") ?? "";
    const m = /\/diziler\/(?:arsiv|guncel)\/([a-z0-9-]+)\/?$/i.exec(href);
    const slug = m?.[1] ?? "";
    if (!slug || JUNK_SLUGS.has(slug)) continue;
    const img = a.selectOne("img") ?? a.parent()?.selectOne("img");
    const title = decodeHtmlEntities(a.attr("title") || img?.attr("alt") || a.text() || titleFromSlug(slug))
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length < 2) continue;
    const rawPoster = img?.attr("data-src") || img?.attr("src");
    const poster = rawPoster && !rawPoster.startsWith("data:") ? absoluteUrl(tv2Base, rawPoster) : undefined;
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { nativeId: `tv2:${slug}`, type: "series", title, poster });
    }
  }
  return Array.from(bySlug.values()).slice(0, 36);
}

async function fetchAllNetworkShows(bases: NetworkBases): Promise<{
  now: MediaSummary[];
  show: MediaSummary[];
  kanald: MediaSummary[];
  star: MediaSummary[];
  atv: MediaSummary[];
  tv2: MediaSummary[];
}> {
  const [now, show, kanald, star, atv, tv2] = await Promise.all([
    fetchNowHomeShows(bases.now).catch(() => []),
    fetchShowHomeShows(bases.show).catch(() => []),
    fetchKanalDHomeShows(bases.kanald).catch(() => []),
    fetchStarHomeShows(bases.star).catch(() => []),
    fetchAtvHomeShows(bases.atv).catch(() => []),
    fetchTv2HomeShows(bases.tv2).catch(() => []),
  ]);
  return { now, show, kanald, star, atv, tv2 };
}

function buildSequentialEpisodes(
  prefix: string,
  slug: string,
  maxEpisode: number,
  explicitEpisodes: Map<number, Episode> = new Map(),
): Episode[] {
  const count = Math.max(maxEpisode, 1);
  const out: Episode[] = [];
  for (let ep = 1; ep <= count; ep++) {
    const existing = explicitEpisodes.get(ep);
    if (existing) {
      out.push(existing);
    } else {
      out.push({
        streamId: `${prefix}:${slug}:1:${ep}`,
        season: 1,
        episode: ep,
        title: `${ep}. Bölüm`,
      });
    }
  }
  return out;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const bases = await getNetworkBases();
      const all = await fetchAllNetworkShows(bases);
      const sections: HomeSection[] = [
        { id: "now-tv", title: "NOW TV • Yerli Diziler", layout: "poster" as const, items: all.now },
        { id: "show-tv", title: "Show TV • Yerli Diziler", layout: "poster" as const, items: all.show },
        { id: "kanal-d", title: "Kanal D • Yerli Diziler", layout: "poster" as const, items: all.kanald },
        { id: "star-tv", title: "Star TV • Yerli Diziler", layout: "poster" as const, items: all.star },
        { id: "atv", title: "ATV • Yerli Diziler", layout: "poster" as const, items: all.atv },
        { id: "tv2", title: "teve2 • Dizi Arşivi", layout: "poster" as const, items: all.tv2 },
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
      const bases = await getNetworkBases();
      const all = await fetchAllNetworkShows(bases);
      const qClean = ultraClean(query);
      if (!qClean) return { items: [], hasMore: false };

      const combined = [
        ...all.now,
        ...all.show,
        ...all.kanald,
        ...all.star,
        ...all.atv,
        ...all.tv2,
      ];
      const matched = combined.filter((s) => ultraClean(s.title).includes(qClean));
      return { items: dedupeMediaSummaries(matched), hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const bases = await getNetworkBases();
    const colonIdx = nativeId.indexOf(":");
    const net = colonIdx !== -1 ? nativeId.slice(0, colonIdx) : "now";
    const slug = colonIdx !== -1 ? nativeId.slice(colonIdx + 1) : nativeId;

    if (net === "now") {
      const showHtml = await fetchText(`${bases.now}/${slug}`, {
        headers: buildHeaders(`${bases.now}/`),
      });
      if (!showHtml) throw new Error(`NOW TV dizisi açılamadı: ${slug}`);
      const doc = html.parse(showHtml);
      const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || titleFromSlug(slug)).trim();
      const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
      let maxEp = 0;
      for (const a of doc.select(`a[href*="/${slug}/bolum/"]`)) {
        const m = /\/bolum\/(\d+)/.exec(a.attr("href") ?? "");
        if (m?.[1]) maxEp = Math.max(maxEp, Number.parseInt(m[1], 10));
      }
      const episodes = buildSequentialEpisodes("now", slug, maxEp || 10);
      return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
    }

    if (net === "show") {
      const cleanSlug = slug.split("/")[0] ?? slug;
      const showHtml =
        (await fetchText(`${bases.show}/dizi/tanitim/${slug}`, {
          headers: buildHeaders(`${bases.show}/`),
        })) ??
        (slug !== cleanSlug
          ? await fetchText(`${bases.show}/dizi/tanitim/${cleanSlug}`, {
              headers: buildHeaders(`${bases.show}/`),
            })
          : null);
      if (!showHtml) throw new Error(`Show TV dizisi açılamadı: ${slug}`);
      const doc = html.parse(showHtml);
      const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || titleFromSlug(cleanSlug)).trim();
      const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
      const explicit = new Map<number, Episode>();
      let maxEp = 0;
      for (const a of doc.select('a[href*="/dizi/tum_bolumler/"]')) {
        const href = a.attr("href") ?? "";
        const m = /-sezon-(\d+)-bolum-(\d+)-izle/i.exec(href) ?? /-(\d+)-bolum-izle/i.exec(href);
        if (!m) continue;
        const s = m[2] ? Number.parseInt(m[1]!, 10) : 1;
        const e = m[2] ? Number.parseInt(m[2]!, 10) : Number.parseInt(m[1]!, 10);
        maxEp = Math.max(maxEp, e);
        if (!explicit.has(e)) {
          explicit.set(e, {
            streamId: `show:${cleanSlug}:${s}:${e}:${encodeURIComponent(href)}`,
            season: s,
            episode: e,
            title: `${s}. Sezon ${e}. Bölüm`,
          });
        }
      }
      const episodes = buildSequentialEpisodes("show", slug, maxEp || 1, explicit);
      return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
    }

    if (net === "kanald") {
      const showHtml =
        (await fetchText(`${bases.kanald}/${slug}/bolumler`, {
          headers: buildHeaders(`${bases.kanald}/`),
        })) ??
        (await fetchText(`${bases.kanald}/${slug}`, {
          headers: buildHeaders(`${bases.kanald}/`),
        }));
      if (!showHtml) throw new Error(`Kanal D dizisi açılamadı: ${slug}`);
      const doc = html.parse(showHtml);
      const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || titleFromSlug(slug)).trim();
      const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
      let maxEp = 0;
      for (const a of doc.select('a[href*="/bolumler/"]')) {
        const m = /-(\d+)-bolum/i.exec(a.attr("href") ?? "");
        if (m?.[1]) maxEp = Math.max(maxEp, Number.parseInt(m[1], 10));
      }
      const episodes = buildSequentialEpisodes("kanald", slug, maxEp || 1);
      return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
    }

    if (net === "star") {
      const showHtml = await fetchText(`${bases.star}/dizi/${slug}/bolumler`, {
        headers: buildHeaders(`${bases.star}/`),
      });
      if (!showHtml) throw new Error(`Star TV dizisi açılamadı: ${slug}`);
      const doc = html.parse(showHtml);
      const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || titleFromSlug(slug)).trim();
      const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
      let maxEp = 0;
      for (const a of doc.select('a[href*="/bolumler/"]')) {
        const m = /\/(\d+)-bolum/i.exec(a.attr("href") ?? "");
        if (m?.[1]) maxEp = Math.max(maxEp, Number.parseInt(m[1], 10));
      }
      const episodes = buildSequentialEpisodes("star", slug, maxEp || 1);
      return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
    }

    if (net === "atv") {
      const showHtml = await fetchText(`${bases.atv}/${slug}/bolumler`, {
        headers: buildHeaders(`${bases.atv}/`),
      });
      if (!showHtml) throw new Error(`ATV dizisi açılamadı: ${slug}`);
      const doc = html.parse(showHtml);
      const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || titleFromSlug(slug)).trim();
      const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
      let maxEp = 0;
      for (const a of doc.select(`a[href*="/${slug}/"][href*="-bolum"]`)) {
        const m = /\/(\d+)-bolum/i.exec(a.attr("href") ?? "");
        if (m?.[1]) maxEp = Math.max(maxEp, Number.parseInt(m[1], 10));
      }
      const episodes = buildSequentialEpisodes("atv", slug, maxEp || 1);
      return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
    }

    if (net === "tv2") {
      const showHtml =
        (await fetchText(`${bases.tv2}/diziler/arsiv/${slug}/bolumler`, {
          headers: buildHeaders(`${bases.tv2}/`),
        })) ??
        (await fetchText(`${bases.tv2}/diziler/guncel/${slug}/bolumler`, {
          headers: buildHeaders(`${bases.tv2}/`),
        }));
      if (!showHtml) throw new Error(`teve2 dizisi açılamadı: ${slug}`);
      const doc = html.parse(showHtml);
      const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || titleFromSlug(slug)).trim();
      const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
      let maxEp = 0;
      for (const a of doc.select('a[href*="-bolum"]')) {
        const m = /-(\d+)-bolum/i.exec(a.attr("href") ?? "");
        if (m?.[1]) maxEp = Math.max(maxEp, Number.parseInt(m[1], 10));
      }
      const episodes = buildSequentialEpisodes("tv2", slug, maxEp || 1);
      return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
    }

    throw new Error(`Bilinmeyen kanal ön eki: ${nativeId}`);
  },

  async getStreams(streamId) {
    try {
      const bases = await getNetworkBases();
      const parts = streamId.split(":");
      const head = parts[0] ?? "";

      if (head === "now" && parts[1]) {
        const ep = Number.parseInt(parts[3] ?? parts[2] ?? "1", 10) || 1;
        const streams = await resolveNowEpisode(bases.now, parts[1], ep);
        if (streams.length === 0) {
          streams.push(
            ...(await searchOfficialYouTubeEpisode(titleFromSlug(parts[1]), ep, "NOW TV / Resmi YouTube")),
          );
        }
        return finalizeStreams(streams);
      }
      if (head === "show" && parts[1]) {
        const s = Number.parseInt(parts[2] ?? "1", 10) || 1;
        const ep = Number.parseInt(parts[3] ?? "1", 10) || 1;
        const directPath = parts[4] ? decodeURIComponent(parts[4]) : undefined;
        const streams = await resolveShowEpisode(bases.show, parts[1], s, ep, directPath);
        if (streams.length === 0) {
          const cleanShow = parts[1].split("/")[0] ?? parts[1];
          const showMeta = (await fetchShowHomeShows(bases.show)).find((x) =>
            x.nativeId.startsWith(`show:${cleanShow}`),
          );
          streams.push(
            ...(await searchOfficialYouTubeEpisode(
              showMeta?.title || titleFromSlug(cleanShow),
              ep,
              "Show TV / Resmi YouTube",
            )),
          );
        }
        return finalizeStreams(streams);
      }
      if (head === "kanald" && parts[1]) {
        const ep = Number.parseInt(parts[3] ?? parts[2] ?? "1", 10) || 1;
        const streams = await resolveKanalDEpisode(bases.kanald, parts[1], ep);
        if (streams.length === 0) {
          streams.push(
            ...(await searchOfficialYouTubeEpisode(titleFromSlug(parts[1]), ep, "Kanal D / Resmi YouTube")),
          );
        }
        return finalizeStreams(streams);
      }
      if (head === "star" && parts[1]) {
        const ep = Number.parseInt(parts[3] ?? parts[2] ?? "1", 10) || 1;
        const streams = await resolveStarEpisode(bases.star, parts[1], ep);
        if (streams.length === 0) {
          streams.push(
            ...(await searchOfficialYouTubeEpisode(titleFromSlug(parts[1]), ep, "Star TV / Resmi YouTube")),
          );
        }
        return finalizeStreams(streams);
      }
      if (head === "atv" && parts[1]) {
        const ep = Number.parseInt(parts[3] ?? parts[2] ?? "1", 10) || 1;
        const streams = await resolveAtvEpisode(bases.atv, parts[1], ep);
        if (streams.length === 0) {
          streams.push(
            ...(await searchOfficialYouTubeEpisode(titleFromSlug(parts[1]), ep, "ATV / Resmi YouTube")),
          );
        }
        return finalizeStreams(streams);
      }
      if (head === "tv2" && parts[1]) {
        const ep = Number.parseInt(parts[3] ?? parts[2] ?? "1", 10) || 1;
        return finalizeStreams(await resolveTv2Episode(bases.tv2, parts[1], ep));
      }

      const route = parseRouteId(streamId);
      const identity = await resolveTmdbIdentity(route.id, "series");
      if (!identity) return { streams: [] };
      // Only match Turkish TV series on national networks; never guess YouTube for foreign shows.
      if (identity.originalLanguage && identity.originalLanguage !== "tr") {
        return { streams: [] };
      }

      const slug = slugify(identity.title);
      if (!slug) return { streams: [] };

      const settled = await Promise.all([
        resolveNowEpisode(bases.now, slug, route.episode),
        resolveShowEpisode(bases.show, slug, route.season, route.episode),
        resolveKanalDEpisode(bases.kanald, slug, route.episode),
        resolveStarEpisode(bases.star, slug, route.episode),
        resolveAtvEpisode(bases.atv, slug, route.episode),
        resolveTv2Episode(bases.tv2, slug, route.episode),
      ]);
      const all = settled.flat();
      if (all.length === 0) {
        all.push(
          ...(await searchOfficialYouTubeEpisode(
            identity.title,
            route.episode,
            "Resmi YouTube",
          )),
        );
      }
      return finalizeStreams(all);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
