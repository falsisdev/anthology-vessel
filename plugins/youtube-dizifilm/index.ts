import { definePlugin } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
} from "vessel";
import {
  postJson,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import { finalizeStreams } from "./shared/core/plugin-helpers.ts";
import { asciiFold } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import {
  resolveYouTubeInnertube,
  searchOfficialYouTubeEpisode,
} from "./shared/extractors/youtube.ts";

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

const TMDB_W500 = "https://image.tmdb.org/t/p/w500";

const CURATED_SERIES: Array<{ tmdbId: string; title: string; year: number; poster: string }> = [
  { tmdbId: "34587", title: "Kurtlar Vadisi", year: 2003, poster: `${TMDB_W500}/yX6JEIijuH6KNCgO8I2yLKu2Psb.jpg` },
  { tmdbId: "32519", title: "Ezel", year: 2009, poster: `${TMDB_W500}/pHSjh4MINU2JnK7qQvjogQaX3wr.jpg` },
  { tmdbId: "17635", title: "Aşk-ı Memnu", year: 2008, poster: `${TMDB_W500}/xHulNzEqtgkTuwrRorBRXdGzHML.jpg` },
  { tmdbId: "39176", title: "Behzat Ç.", year: 2010, poster: `${TMDB_W500}/aRqNQ5v2tvZ9ZRAXpYik0JamHkm.jpg` },
  { tmdbId: "39352", title: "Leyla ile Mecnun", year: 2011, poster: `${TMDB_W500}/wjiDfj2xkgezLgX5CpospTNL2dv.jpg` },
  { tmdbId: "60682", title: "Kardeş Payı", year: 2014, poster: `${TMDB_W500}/jjJLCziBOVbNNtOs2N9Mvw1O3oR.jpg` },
  { tmdbId: "68349", title: "İçerde", year: 2016, poster: `${TMDB_W500}/ssKVvJM341QiRdBmj8fOAOcpYdl.jpg` },
  { tmdbId: "74431", title: "Çukur", year: 2017, poster: `${TMDB_W500}/2OcUsjKyHDqCmtdJGAHUDaB2xBT.jpg` },
  { tmdbId: "115678", title: "Gibi", year: 2021, poster: `${TMDB_W500}/sOzTUfTc1djfZM46PgsjuOjs5U1.jpg` },
  { tmdbId: "112454", title: "Gönül Dağı", year: 2020, poster: `${TMDB_W500}/eAzjjcVNDynJz1ir7zVVnLwHyx.jpg` },
];

const CURATED_MOVIES: Array<{ tmdbId: string; title: string; year: number; poster: string }> = [
  { tmdbId: "38794", title: "Tosun Paşa", year: 1976, poster: `${TMDB_W500}/aE8cMuRNYltzzW36N2hC3zyZQm2.jpg` },
  { tmdbId: "83651", title: "Hababam Sınıfı", year: 1975, poster: `${TMDB_W500}/n58QmaMaw7kN3sg2EEV9HMq0jkR.jpg` },
  { tmdbId: "27211", title: "Kibar Feyzo", year: 1978, poster: `${TMDB_W500}/nfgnDKDUS5AryFRh4xI1zLLvdoR.jpg` },
  { tmdbId: "30634", title: "Organize İşler", year: 2005, poster: `${TMDB_W500}/9hydImnaVkVv6PinLMzozFiPP1h.jpg` },
  { tmdbId: "57892", title: "Vizontele", year: 2001, poster: `${TMDB_W500}/ipHbJ54NuA8tobUDrEV6odOrYhK.jpg` },
  { tmdbId: "27275", title: "G.O.R.A.", year: 2004, poster: `${TMDB_W500}/bxHULJqeW1GlPWr7uvRoWQWsDIe.jpg` },
];

interface InnertubeSearchPayload {
  contents?: {
    sectionListRenderer?: {
      contents?: Array<{
        itemSectionRenderer?: {
          contents?: Array<{
            videoWithContextRenderer?: InnertubeVideoNode;
            compactVideoRenderer?: InnertubeVideoNode;
            videoRenderer?: InnertubeVideoNode;
          }>;
        };
      }>;
    };
  };
}

interface InnertubeVideoNode {
  videoId?: string;
  headline?: { runs?: Array<{ text?: string }> };
  title?: { runs?: Array<{ text?: string }>; simpleText?: string };
  lengthText?: { runs?: Array<{ text?: string }>; simpleText?: string };
  thumbnail?: { thumbnails?: Array<{ url?: string }> };
}

function parseDurationSeconds(txt?: string): number {
  if (!txt) return 0;
  const parts = txt.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return (parts[0]! * 3600) + (parts[1]! * 60) + parts[2]!;
  if (parts.length === 2) return (parts[0]! * 60) + parts[1]!;
  return parts[0] ?? 0;
}

async function searchYouTubeMweb(query: string): Promise<Array<{ id: string; title: string; poster?: string; durationSec: number }>> {
  const data = await postJson<InnertubeSearchPayload>(
    `https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}`,
    {
      query,
      context: {
        client: {
          clientName: "MWEB",
          clientVersion: "2.20240313.00.00",
          hl: "tr",
          gl: "TR",
        },
      },
    },
    { timeoutMs: 7_000 },
  );
  const out: Array<{ id: string; title: string; poster?: string; durationSec: number }> = [];
  const seen = new Set<string>();
  const sections = data?.contents?.sectionListRenderer?.contents ?? [];
  for (const sec of sections) {
    for (const item of sec.itemSectionRenderer?.contents ?? []) {
      const v = item.videoWithContextRenderer ?? item.compactVideoRenderer ?? item.videoRenderer;
      if (!v?.videoId || seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      const title =
        v.headline?.runs?.[0]?.text ??
        v.title?.runs?.[0]?.text ??
        v.title?.simpleText ??
        "";
      const dur = v.lengthText?.runs?.[0]?.text ?? v.lengthText?.simpleText;
      const thumb = v.thumbnail?.thumbnails?.[0]?.url;
      out.push({
        id: v.videoId,
        title,
        poster: thumb,
        durationSec: parseDurationSeconds(dur),
      });
    }
  }
  return out;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    const seriesItems: MediaSummary[] = CURATED_SERIES.map((s) => ({
      nativeId: `tmdb:series:${s.tmdbId}`,
      type: "series",
      title: s.title,
      year: s.year,
      poster: s.poster,
    }));
    const movieItems: MediaSummary[] = CURATED_MOVIES.map((m) => ({
      nativeId: `tmdb:movie:${m.tmdbId}`,
      type: "movie",
      title: m.title,
      year: m.year,
      poster: m.poster,
    }));
    return {
      sections: [
        { id: "tr-series", title: "Resmi Türk Dizileri (YouTube)", layout: "poster", items: seriesItems },
        { id: "tr-movies", title: "Klasik Türk Filmleri (YouTube)", layout: "poster", items: movieItems },
      ],
    };
  },

  async search(query, _filters, page): Promise<SearchPage> {
    try {
      if (page > 1 || !query.trim()) return { items: [], hasMore: false };
      const qLower = asciiFold(query);
      const curated = [...CURATED_SERIES, ...CURATED_MOVIES]
        .filter((x) => asciiFold(x.title).includes(qLower))
        .map<MediaSummary>((x) => ({
          nativeId: `tmdb:${CURATED_MOVIES.some((m) => m.tmdbId === x.tmdbId) ? "movie" : "series"}:${x.tmdbId}`,
          type: CURATED_MOVIES.some((m) => m.tmdbId === x.tmdbId) ? "movie" : "series",
          title: x.title,
          year: x.year,
          poster: x.poster,
        }));

      const ytHits = await searchYouTubeMweb(`${query.trim()} tek parca full izle`);
      const fullVods = ytHits.filter((h) => h.durationSec >= 900);
      const selectedHits = fullVods.length > 0 ? fullVods : ytHits.filter((h) => h.durationSec === 0);
      const videoItems: MediaSummary[] = selectedHits
        .slice(0, 15)
        .map((h) => ({
          nativeId: `ytvid:${h.id}:${encodeURIComponent(h.title)}`,
          type: "movie",
          title: h.title,
          poster: h.poster,
        }));

      return { items: [...curated, ...videoItems], hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    if (nativeId.startsWith("ytvid:")) {
      const parts = nativeId.split(":");
      const vidId = parts[1] ?? "";
      const title = decodeURIComponent(parts.slice(2).join(":") || "YouTube Video");
      return {
        nativeId,
        type: "movie",
        title,
        episodes: [{ streamId: `ytid:${vidId}`, season: 1, episode: 1, title }],
      };
    }

    const parts = nativeId.split(":");
    const isSeries = parts[1] === "series";
    const tmdbId = parts[2] ?? nativeId;
    const identity = await resolveTmdbIdentity(tmdbId, isSeries ? "series" : "movie");
    const curatedMatch = [...CURATED_SERIES, ...CURATED_MOVIES].find(
      (c) => c.tmdbId === tmdbId,
    );
    const title = identity?.title || curatedMatch?.title || "YouTube İçeriği";

    if (!isSeries) {
      return {
        nativeId,
        type: "movie",
        title,
        year: identity?.year ?? curatedMatch?.year,
        poster: identity?.poster,
        backdrop: identity?.backdrop,
        synopsis: identity?.synopsis,
        episodes: [{ streamId: `ytmovie:${encodeURIComponent(title)}`, season: 1, episode: 1, title }],
      };
    }

    const epCount = Math.min(identity?.seasons[0]?.episodeCount ?? 20, 40);
    const episodes: Episode[] = [];
    for (let e = 1; e <= epCount; e++) {
      episodes.push({
        streamId: `ytep:${encodeURIComponent(title)}:1:${e}`,
        season: 1,
        episode: e,
        title: `${e}. Bölüm`,
      });
    }
    return {
      nativeId,
      type: "series",
      title,
      year: identity?.year ?? curatedMatch?.year,
      poster: identity?.poster,
      backdrop: identity?.backdrop,
      synopsis: identity?.synopsis,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      if (streamId.startsWith("ytid:")) {
        const res = await resolveYouTubeInnertube(streamId.slice(5), "YouTube Resmi");
        return finalizeStreams(res?.streams ?? []);
      }

      if (streamId.startsWith("ytmovie:")) {
        const title = decodeURIComponent(streamId.slice(8));
        const hits = await searchYouTubeMweb(`${title} full film tek parca izle`);
        for (const h of hits.filter((x) => x.durationSec === 0 || x.durationSec >= 2400).slice(0, 3)) {
          const resolved = await resolveYouTubeInnertube(h.id, "YouTube Resmi");
          if (resolved && resolved.streams.length > 0) return finalizeStreams(resolved.streams);
        }
        return { streams: [] };
      }

      if (streamId.startsWith("ytep:")) {
        const [, encTitle, , epStr] = streamId.split(":");
        const title = decodeURIComponent(encTitle ?? "");
        const epNum = Number.parseInt(epStr ?? "1", 10) || 1;
        return finalizeStreams(await searchOfficialYouTubeEpisode(title, epNum, "YouTube Resmi"));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[1] && parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };

      if (typeHint === "movie") {
        const hits = await searchYouTubeMweb(`${identity.title} full film tek parca izle`);
        for (const h of hits.filter((x) => x.durationSec === 0 || x.durationSec >= 2400).slice(0, 3)) {
          const resolved = await resolveYouTubeInnertube(h.id, "YouTube Resmi");
          if (resolved && resolved.streams.length > 0) return finalizeStreams(resolved.streams);
        }
        return { streams: [] };
      }

      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;
      return finalizeStreams(
        await searchOfficialYouTubeEpisode(identity.title, eTarget, "YouTube Resmi"),
      );
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
