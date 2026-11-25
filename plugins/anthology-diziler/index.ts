import { definePlugin, html } from "vessel";
import type {
  Episode,
  HomeFeed,
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
    configString("urls.series.anthology_diziler.kanald", "https://kanald.com.tr"),
    configString("urls.series.anthology_diziler.atv", "https://www.atv.com.tr"),
    configString("urls.series.anthology_diziler.star", "https://www.startv.com.tr"),
    configString("urls.series.anthology_diziler.tv2", "https://www.tv2.com.tr"),
  ]);
  return {
    now: now.replace(/\/+$/, ""),
    show: show.replace(/\/+$/, ""),
    kanald: kanald.replace(/\/+$/, ""),
    atv: atv.replace(/\/+$/, ""),
    star: star.replace(/\/+$/, ""),
    tv2: tv2.replace(/\/+$/, ""),
  };
}

const NOW_JUNK_SLUGS = new Set([
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
]);

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
        label: `NOW TV • ${slug} • ${ep}. Bölüm (1080p HLS)`,
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
  slug: string,
  season: number,
  episode: number,
): Promise<StreamCandidate[]> {
  const listing = await fetchText(
    `${showBase}/kanal/dizi/tum_bolumler/${slug}`,
    { timeoutMs: 10_000, headers: buildHeaders(`${showBase}/`) },
  );
  if (!listing) return [];

  const doc = html.parse(listing);
  let targetHref = "";
  for (const a of doc.select('a[href*="/dizi/tum_bolumler/"]')) {
    const href = a.attr("href");
    if (!href) continue;
    const m = /-sezon-(\d+)-bolum-(\d+)-izle/i.exec(href);
    if (m && Number(m[1]) === season && Number(m[2]) === episode) {
      targetHref = href;
      break;
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
      /https:\/\/vmcdn\.ciner\.com\.tr\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i.exec(
        epHtml,
      )?.[0] ?? "";
  }
  if (!m3u8) return [];

  return [
    createStream({
      url: m3u8,
      kind: "hls",
      quality: "1080p",
      label: `Show TV • S${season}E${episode} (1080p HLS)`,
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
    `${kanaldBase}/${slug}/bolumler/${slug}-son-bolum`,
  ]) {
    const rawHtml = await fetchText(url, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${kanaldBase}/`),
    });
    const m = rawHtml
      ? /https?:\/\/kanaldvod\.duhnet\.tv\/[^"'\s\\]+\.smil\/playlist\.m3u8[^"'\s\\]*/i.exec(
          rawHtml,
        )
      : null;
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
  const rawHtml = await fetchText(`${starBase}/${slug}/${episode}-bolum-izle`, {
    timeoutMs: 8_000,
    headers: buildHeaders(`${starBase}/`),
  });
  const rid = rawHtml
    ? /referenceId["']?\s*[:=]\s*["']?([a-f0-9]{24})/i.exec(rawHtml)?.[1]
    : null;
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
  for (const prefix of ["diziler", "programlar"]) {
    const listHtml = await fetchText(`${tv2Base}/${prefix}/guncel/${slug}/bolumler`, {
      timeoutMs: 8_000,
      headers: buildHeaders(`${tv2Base}/`),
    });
    if (!listHtml) continue;
    const epPath = listHtml.match(
      new RegExp(`/${prefix}/guncel/${slug}/bolumler/${slug}-${episode}-bolum`, "i"),
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

async function fetchNowHomeShows(nowBase: string): Promise<MediaSummary[]> {
  const rawHtml = await fetchText(`${nowBase}/`, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${nowBase}/`),
  });
  if (!rawHtml) return [];
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select(`a[href^="${nowBase}/"]`)) {
    const href = a.attr("href") ?? "";
    const slug = href.slice(nowBase.length + 1).split("/")[0]?.trim() ?? "";
    if (!slug || /^\d/.test(slug) || NOW_JUNK_SLUGS.has(slug) || seen.has(slug)) continue;
    const img = a.selectOne("img");
    const rawTitle = decodeHtmlEntities(img?.attr("alt") || a.text()).trim();
    if (!rawTitle || rawTitle.length < 2) continue;
    seen.add(slug);
    const poster = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `now:${slug}`,
      type: "series",
      title: rawTitle,
      poster: poster ? absoluteUrl(nowBase, poster) : undefined,
    });
  }
  return dedupeMediaSummaries(items).slice(0, 36);
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const bases = await getNetworkBases();
      const nowShows = await fetchNowHomeShows(bases.now);
      return {
        sections:
          nowShows.length > 0
            ? [{ id: "now-tv", title: "NOW TV • Güncel Yerli Diziler", layout: "poster", items: nowShows }]
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
      const bases = await getNetworkBases();
      const nowShows = await fetchNowHomeShows(bases.now);
      const qClean = ultraClean(query);
      const matched = nowShows.filter((s) => ultraClean(s.title).includes(qClean));
      if (matched.length > 0) return { items: matched, hasMore: false };

      const slug = slugify(query);
      return {
        items: slug
          ? [{ nativeId: `auto:${slug}:${encodeURIComponent(query.trim())}`, type: "series", title: query.trim() }]
          : [],
        hasMore: false,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const bases = await getNetworkBases();
    if (nativeId.startsWith("now:")) {
      const slug = nativeId.slice(4);
      const showHtml = await fetchText(`${bases.now}/${slug}`, {
        headers: buildHeaders(`${bases.now}/`),
      });
      const doc = showHtml ? html.parse(showHtml) : null;
      const title = decodeHtmlEntities(
        doc?.selectOne("h1")?.text() || slug.replace(/-/g, " "),
      ).trim();
      const poster = doc?.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
      const episodes: Episode[] = [];
      const seenEp = new Set<number>();
      if (doc) {
        for (const a of doc.select(`a[href*="/${slug}/bolum/"]`)) {
          const m = /\/bolum\/(\d+)/.exec(a.attr("href") ?? "");
          if (!m?.[1]) continue;
          const epNum = Number.parseInt(m[1], 10);
          if (seenEp.has(epNum)) continue;
          seenEp.add(epNum);
          episodes.push({
            streamId: `now:${slug}:1:${epNum}`,
            season: 1,
            episode: epNum,
            title: `${epNum}. Bölüm`,
          });
        }
      }
      if (episodes.length === 0) {
        for (let e = 1; e <= 10; e++) {
          episodes.push({
            streamId: `now:${slug}:1:${e}`,
            season: 1,
            episode: e,
            title: `${e}. Bölüm`,
          });
        }
      }
      episodes.sort((a, b) => a.episode - b.episode);
      return { nativeId, type: "series", title, poster, backdrop: poster, episodes };
    }

    const parts = nativeId.split(":");
    const slug = parts[1] ?? slugify(nativeId);
    const title = decodeURIComponent(parts[2] ?? slug.replace(/-/g, " "));
    const episodes: Episode[] = [];
    for (let e = 1; e <= 12; e++) {
      episodes.push({
        streamId: `auto:${slug}:1:${e}:${encodeURIComponent(title)}`,
        season: 1,
        episode: e,
        title: `${e}. Bölüm`,
      });
    }
    return { nativeId, type: "series", title, episodes };
  },

  async getStreams(streamId) {
    try {
      const bases = await getNetworkBases();
      const parts = streamId.split(":");

      if (parts[0] === "now" && parts[1]) {
        const ep = Number.parseInt(parts[3] ?? parts[2] ?? "1", 10) || 1;
        return finalizeStreams(await resolveNowEpisode(bases.now, parts[1], ep));
      }

      let slug = "";
      let title = "";
      let season = 1;
      let episode = 1;

      if (parts[0] === "auto" && parts[1]) {
        slug = parts[1];
        season = Number.parseInt(parts[2] ?? "1", 10) || 1;
        episode = Number.parseInt(parts[3] ?? "1", 10) || 1;
        title = decodeURIComponent(parts[4] ?? slug.replace(/-/g, " "));
      } else {
        const identity = await resolveTmdbIdentity(parts[0] ?? streamId, "series");
        if (!identity) return { streams: [] };
        title = identity.title;
        slug = slugify(title);
        season = Number.parseInt(parts[1] ?? "1", 10) || 1;
        episode = Number.parseInt(parts[2] ?? "1", 10) || 1;
      }

      if (!slug) return { streams: [] };

      const settled = await Promise.all([
        resolveNowEpisode(bases.now, slug, episode),
        resolveShowEpisode(bases.show, slug, season, episode),
        resolveKanalDEpisode(bases.kanald, slug, episode),
        resolveStarEpisode(bases.star, slug, episode),
        resolveAtvEpisode(bases.atv, slug, episode),
        resolveTv2Episode(bases.tv2, slug, episode),
      ]);
      const all = settled.flat();
      if (all.length === 0 && title) {
        all.push(...(await searchOfficialYouTubeEpisode(title, episode, "TRT1 / Resmi YouTube")));
      }

      return finalizeStreams(all);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
