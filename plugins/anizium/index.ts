import { definePlugin, storage } from "vessel";
import type {
  AudioType,
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
  StreamCandidate,
  SubtitleTrack,
} from "vessel";
import { configString, resolveBaseUrl } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchJson,
  postJson,
  rethrowIfDomainBlocked,
  safeRequest,
} from "./shared/core/http.ts";
import { finalizeStreams } from "./shared/core/plugin-helpers.ts";
import { createStream } from "./shared/core/quality.ts";
import { asciiFold, dedupeStrings } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import {
  collectAnimeSearchTitles,
  resolveAnimeTrackerInfo,
} from "./shared/core/anime-helpers.ts";

const DEFAULT_API = "https://api.anizium.co";
const DEFAULT_SITE = "https://anizium.co";
const TOKEN_KEY = "hlxjl1c2w281ax473rt1ofgrvhyjvi";
const CLIENT_KEY = "16ghkdz5qnwinkyebwopbd94b49xhs";
const SESSION_CACHE_KEY = "__anizium_auth_session_v1";

interface AniziumAnimeItem {
  ID?: number | string;
  name?: string;
  type?: string;
  poster?: string;
  banner?: string;
  details_banner?: string;
  overview?: string;
}

interface AniziumSeason {
  number?: number;
  episodes?: Array<{ number?: number; name?: string }>;
}

interface AniziumSourceItem {
  link?: string;
  quality?: number;
  type?: string;
}

interface AniziumSourceGroup {
  group?: string;
  name?: string;
  items?: AniziumSourceItem[];
}

interface AniziumSubItem {
  link?: string;
  group?: string;
}

interface AniziumHomeResponse {
  success?: boolean;
  settlement_top?: AniziumAnimeItem[];
  settlement_middle?: AniziumAnimeItem[];
  settlement_lower?: AniziumAnimeItem[];
}

interface AniziumSearchResponse {
  page?: { data?: AniziumAnimeItem[] };
}

interface AniziumDetailResponse {
  success?: boolean;
  data?: AniziumAnimeItem & { seasons?: AniziumSeason[] };
}

interface AniziumSourceResponse {
  success?: boolean;
  groups?: AniziumSourceGroup[];
  subtitles?: AniziumSubItem[];
}

function cleanAnimeStr(str?: string): string {
  if (!str) return "";
  return asciiFold(str)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getIstanbulDay(): string {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const ist = new Date(utc + 3_600_000 * 3);
  return days[ist.getDay()] ?? "monday";
}

function utf8ToBytes(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(++i);
      code = 0x10000 + (((code - 0xd800) << 10) | (low - 0xdc00));
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

function xorEncryptHex(text: string, key: string): string {
  const textBytes = utf8ToBytes(text);
  const keyBytes = utf8ToBytes(key);
  let out = "";
  for (let i = 0; i < textBytes.length; i++) {
    const code = (textBytes[i] ?? 0) ^ (keyBytes[i % keyBytes.length] ?? 0);
    const hex = code.toString(16);
    out += hex.length < 2 ? `0${hex}` : hex;
  }
  return out;
}

function generateCfControl(): string {
  const key = `${TOKEN_KEY}_${getIstanbulDay()}`;
  const randomKey = Math.random().toString(36).substring(2, 8);
  return xorEncryptHex(JSON.stringify({ [randomKey]: Date.now() }), key);
}

interface AniziumAuthSession {
  email?: string;
  session: string;
  profile: string;
  at: number;
}

interface AniziumLoginResponse {
  success?: boolean;
  session?: string;
  msg?: string;
}

interface AniziumUserResponse {
  success?: boolean;
  data?: {
    profiles?: Array<{ ID?: number | string }>;
  };
}

async function resolveAniziumAuth(
  apiBase: string,
  siteOrigin: string,
): Promise<{ session: string; profile: string } | null> {
  const [manualSession, manualProfile, emailRaw, passwordRaw] = await Promise.all([
    storage.getSetting<string>("userSession"),
    storage.getSetting<string>("userProfile"),
    storage.getSetting<string>("aniziumEmail"),
    storage.getSetting<string>("aniziumPassword"),
  ]);

  const directSession = manualSession?.trim() ?? "";
  const directProfile = manualProfile?.trim() ?? "";
  if (directSession) {
    return { session: directSession, profile: directProfile };
  }

  const email = emailRaw?.trim() ?? "";
  const password = passwordRaw ?? "";
  if (!email || !password) return null;

  try {
    const cached = await storage.get<AniziumAuthSession>(SESSION_CACHE_KEY);
    if (
      cached &&
      cached.email === email &&
      cached.session &&
      Date.now() - cached.at < 12 * 60 * 60 * 1000
    ) {
      return { session: cached.session, profile: cached.profile };
    }
  } catch {
    // Ignore storage read failure.
  }

  const encrypted = xorEncryptHex(
    JSON.stringify({ value: email, password, date: Date.now() }),
    CLIENT_KEY,
  );
  const loginHeaders = {
    ...buildHeaders(`${siteOrigin}/`),
    Origin: siteOrigin,
    "Cf-Control": generateCfControl(),
    device: "browser",
    language: "tr",
    site: "main",
  };
  const loginRes = await postJson<AniziumLoginResponse>(
    `${apiBase}/user/login`,
    { d: encrypted },
    { timeoutMs: 9_000, headers: loginHeaders },
  );
  if (!loginRes?.success || !loginRes.session) return null;

  let profileId = directProfile;
  if (!profileId) {
    const userRes = await fetchJson<AniziumUserResponse>(`${apiBase}/user/get`, {
      timeoutMs: 9_000,
      headers: {
        ...loginHeaders,
        "user-session": loginRes.session,
      },
    });
    const firstProfile = userRes?.data?.profiles?.[0]?.ID;
    if (firstProfile !== undefined && firstProfile !== null) {
      profileId = String(firstProfile);
    }
  }

  try {
    await storage.set(SESSION_CACHE_KEY, {
      email,
      session: loginRes.session,
      profile: profileId,
      at: Date.now(),
    });
  } catch {
    // Non-fatal.
  }
  return { session: loginRes.session, profile: profileId };
}

async function aniziumFetchRaw(
  apiBase: string,
  siteOrigin: string,
  endpoint: string,
  params: Record<string, string | number> = {},
  auth?: { session: string; profile: string } | null,
): Promise<{ status: number; text: string } | null> {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  const url = `${apiBase}${endpoint}${pairs.length > 0 ? `?${pairs.join("&")}` : ""}`;
  const headers: Record<string, string> = {
    ...buildHeaders(`${siteOrigin}/`),
    Origin: siteOrigin,
    Accept: "application/json, text/plain, */*",
    "Cf-Control": generateCfControl(),
    device: "browser",
    language: "tr",
    site: "main",
  };
  if (auth?.session) headers["user-session"] = auth.session;
  if (auth?.profile) headers["user-profile"] = auth.profile;

  const res = await safeRequest(url, { timeoutMs: 9_000, headers });
  if (!res) return null;
  return { status: res.status, text: res.text() };
}

async function aniziumFetch<T>(
  apiBase: string,
  siteOrigin: string,
  endpoint: string,
  params: Record<string, string | number> = {},
  auth?: { session: string; profile: string } | null,
): Promise<T | null> {
  const raw = await aniziumFetchRaw(apiBase, siteOrigin, endpoint, params, auth);
  if (!raw || raw.status < 200 || raw.status >= 300) return null;
  try {
    return JSON.parse(raw.text) as T;
  } catch {
    return null;
  }
}

function mapSummary(item: AniziumAnimeItem): MediaSummary | null {
  if (!item.ID) return null;
  const isMovie = item.type === "movie";
  return {
    nativeId: `${isMovie ? "movie" : "anime"}:${item.ID}`,
    type: isMovie ? "movie" : "series",
    isAnime: true,
    title: item.name || "Anime",
    poster: item.poster || item.details_banner || item.banner || undefined,
  };
}

function mapSubtitles(rawSubs: AniziumSubItem[] | undefined): SubtitleTrack[] {
  const langNames: Record<string, { lang: string; label: string }> = {
    tr: { lang: "tr", label: "Türkçe" },
    en: { lang: "en", label: "İngilizce" },
    de: { lang: "de", label: "Almanca" },
    fr: { lang: "fr", label: "Fransızca" },
    es: { lang: "es", label: "İspanyolca" },
    it: { lang: "it", label: "İtalyanca" },
    ar: { lang: "ar", label: "Arapça" },
  };
  const out: SubtitleTrack[] = [];
  for (const s of rawSubs ?? []) {
    if (!s.link) continue;
    const g = (s.group ?? "tr").toLowerCase();
    const mapped = langNames[g] ?? { lang: g, label: g.toUpperCase() };
    out.push({
      id: `${mapped.lang}_${out.length}`,
      source: { kind: "url", url: s.link },
      lang: mapped.lang,
      label: mapped.label,
      format: "vtt",
      isDefault: mapped.lang === "tr",
    });
  }
  return out;
}

function scoreCandidate(
  item: AniziumAnimeItem,
  query: string,
  expectedIsMovie: boolean | null,
  idx: number,
): number {
  const itemClean = cleanAnimeStr(item.name);
  const qClean = cleanAnimeStr(query);
  if (!itemClean || !qClean) return -9999;

  let titleScore = 0;
  if (itemClean === qClean) titleScore = 500;
  else if (itemClean.startsWith(qClean)) {
    titleScore = 260 - Math.min(200, (itemClean.length - qClean.length) * 3);
  } else if (itemClean.includes(qClean) || qClean.includes(itemClean)) {
    titleScore = 140 - Math.min(120, Math.abs(itemClean.length - qClean.length) * 3);
  } else {
    return -9999;
  }

  let typeScore = 0;
  if (expectedIsMovie !== null) {
    typeScore = (item.type === "movie") === expectedIsMovie ? 1000 : -500;
  }
  return typeScore + titleScore - idx * 0.1;
}

async function searchAniziumBest(
  apiBase: string,
  siteOrigin: string,
  queries: string[],
  expectedIsMovie: boolean | null,
): Promise<AniziumAnimeItem | null> {
  const cleanQueries = dedupeStrings(queries.map((q) => cleanAnimeStr(q))).filter(
    (q) => q.length >= 2,
  );
  if (cleanQueries.length === 0) return null;

  let bestItem: AniziumAnimeItem | null = null;
  let bestScore = -9999;

  for (const q of cleanQueries.slice(0, 4)) {
    const sData = await aniziumFetch<AniziumSearchResponse>(apiBase, siteOrigin, "/page/search", {
      value: q,
      page: 1,
    });
    const items = sData?.page?.data ?? [];
    for (let i = 0; i < items.length; i++) {
      const sc = scoreCandidate(items[i]!, q, expectedIsMovie, i);
      if (sc > bestScore) {
        bestScore = sc;
        bestItem = items[i]!;
      }
      if (bestScore >= 1499) return bestItem;
    }
  }
  return bestItem;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const apiBase = await resolveBaseUrl("urls.anime.anizium.base", DEFAULT_API, "mirrorUrl");
      const siteOrigin = await configString("urls.anime.anizium.site", DEFAULT_SITE);
      const data = await aniziumFetch<AniziumHomeResponse>(apiBase, siteOrigin, "/page/home");
      if (!data?.success) return { sections: [] };

      const merged = [
        ...(data.settlement_top ?? []),
        ...(data.settlement_middle ?? []),
        ...(data.settlement_lower ?? []),
      ];
      const seen = new Set<string>();
      const items: MediaSummary[] = [];
      for (const row of merged) {
        const mapped = mapSummary(row);
        if (!mapped || seen.has(mapped.nativeId)) continue;
        seen.add(mapped.nativeId);
        items.push(mapped);
      }

      return {
        sections:
          items.length > 0
            ? [{ id: "featured", title: "Öne Çıkan Animeler (4K)", layout: "poster", items }]
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
      const apiBase = await resolveBaseUrl("urls.anime.anizium.base", DEFAULT_API, "mirrorUrl");
      const siteOrigin = await configString("urls.anime.anizium.site", DEFAULT_SITE);
      const res = await aniziumFetch<AniziumSearchResponse>(apiBase, siteOrigin, "/page/search", {
        value: query.trim(),
        page: 1,
      });
      const items = (res?.page?.data ?? [])
        .map(mapSummary)
        .filter((x): x is MediaSummary => x !== null);
      return { items, hasMore: false };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const apiBase = await resolveBaseUrl("urls.anime.anizium.base", DEFAULT_API, "mirrorUrl");
    const siteOrigin = await configString("urls.anime.anizium.site", DEFAULT_SITE);
    const cleanId = nativeId.replace(/^(?:anime|movie):/, "");
    const res = await aniziumFetch<AniziumDetailResponse>(apiBase, siteOrigin, "/anime/get", {
      id: cleanId,
    });
    const d = res?.data;
    if (!d) throw new Error(`Anizium içeriği bulunamadı: ${cleanId}`);

    const isMovie = d.type === "movie";
    const name = d.name || "Anime";
    const seasons: SeasonSummary[] = [];
    const episodes: Episode[] = [];

    if (isMovie) {
      episodes.push({
        streamId: `ep:${cleanId}:1:1:movie`,
        season: 1,
        episode: 1,
        title: name,
      });
    } else {
      for (const s of d.seasons ?? []) {
        const sNum = Number(s.number) || 1;
        const eps = s.episodes ?? [];
        seasons.push({
          id: String(sNum),
          season: sNum,
          title: `${sNum}. Sezon`,
          episodeCount: eps.length,
        });
        for (let i = 0; i < eps.length; i++) {
          const eNum = Number(eps[i]?.number) || i + 1;
          const epTitle = eps[i]?.name
            ? `${sNum}. Sezon ${eNum}. Bölüm - ${eps[i]!.name}`
            : `${sNum}. Sezon ${eNum}. Bölüm`;
          episodes.push({
            streamId: `ep:${cleanId}:${sNum}:${eNum}`,
            season: sNum,
            episode: eNum,
            title: epTitle,
          });
        }
      }
    }

    return {
      nativeId,
      type: isMovie ? "movie" : "series",
      isAnime: true,
      title: name,
      poster: d.poster || d.details_banner || d.banner || undefined,
      backdrop: d.banner || d.details_banner || d.poster || undefined,
      synopsis: d.overview || undefined,
      genres: ["Anime"],
      seasons,
      episodes,
    };
  },

  async getStreams(streamId) {
    try {
      const apiBase = await resolveBaseUrl("urls.anime.anizium.base", DEFAULT_API, "mirrorUrl");
      const siteOrigin = await configString("urls.anime.anizium.site", DEFAULT_SITE);

      let aniziumId = "";
      let isMovie = false;
      let sNum = 1;
      let eNum = 1;

      if (streamId.startsWith("ep:") || streamId.startsWith("anime:") || streamId.startsWith("movie:")) {
        const parts = streamId.split(":");
        aniziumId = parts[1] ?? "";
        isMovie = streamId.startsWith("movie:") || parts[4] === "movie";
        sNum = Number.parseInt(parts[2] ?? "1", 10) || 1;
        eNum = Number.parseInt(parts[3] ?? "1", 10) || 1;
      } else {
        const parts = streamId.split(":");
        const head = (parts[0] ?? "").toLowerCase();
        let searchTitles: string[] = [];
        let tmdbLookupId = parts[0] ?? streamId;

        if (head === "kitsu" || head === "mal" || head === "anilist" || head === "anidb") {
          eNum = Number.parseInt(parts[2] ?? "1", 10) || 1;
          const tracker = await resolveAnimeTrackerInfo(head, parts[1] ?? "", eNum);
          searchTitles.push(...tracker.titles);
          if (tracker.isMovie !== null) isMovie = tracker.isMovie;
          if (tracker.mappedSeason) sNum = tracker.mappedSeason;
          if (tracker.mappedEpisode) eNum = tracker.mappedEpisode;
          tmdbLookupId = tracker.tmdbId ?? "";
        } else {
          if (parts.length >= 2) {
            const pS = Number.parseInt(parts[1] ?? "1", 10);
            const pE = Number.parseInt(parts[2] ?? "1", 10);
            if (!Number.isNaN(pS)) sNum = pS;
            if (!Number.isNaN(pE)) eNum = pE;
            isMovie = parts.length < 3;
          }
        }

        if (tmdbLookupId) {
          const identity = await resolveTmdbIdentity(tmdbLookupId, isMovie ? "movie" : "series");
          if (identity) {
            searchTitles = dedupeStrings([...searchTitles, ...collectAnimeSearchTitles(identity)]);
            isMovie = identity.mediaType === "movie";
          }
        }

        const matched = await searchAniziumBest(apiBase, siteOrigin, searchTitles, isMovie);
        if (!matched?.ID) return { streams: [] };
        aniziumId = String(matched.ID);
        isMovie = matched.type === "movie";
      }

      if (!aniziumId) return { streams: [] };

      const params: Record<string, string | number> = {
        id: aniziumId,
        site: "main",
        server: "1",
      };
      if (!isMovie) {
        params.season = sNum;
        params.episode = eNum;
      }

      const auth = await resolveAniziumAuth(apiBase, siteOrigin);
      const srcRaw = await aniziumFetchRaw(
        apiBase,
        siteOrigin,
        "/anime/source",
        params,
        auth,
      );
      if (!srcRaw) return { streams: [] };
      if (srcRaw.status === 401) {
        try {
          await storage.remove(SESSION_CACHE_KEY);
        } catch {
          // Ignore cache clear failure.
        }
        return { streams: [] };
      }
      if (srcRaw.status < 200 || srcRaw.status >= 300) return { streams: [] };

      let srcData: AniziumSourceResponse | null = null;
      try {
        srcData = JSON.parse(srcRaw.text) as AniziumSourceResponse;
      } catch {
        return { streams: [] };
      }
      if (!srcData?.success || !srcData.groups?.length) return { streams: [] };

      const subtitles = mapSubtitles(srcData.subtitles);
      const streamHeaders = buildHeaders(`${siteOrigin}/`);
      const streams: StreamCandidate[] = [];

      for (const group of srcData.groups) {
        const isDub = group.group === "trdub";
        const isEn = group.group === "endub";
        const audioType: AudioType = isDub || isEn ? "dub" : "sub";
        const language = isDub ? "tr" : isEn ? "en" : "ja";
        const groupLabel = isDub
          ? "Türkçe Dublaj"
          : isEn
            ? "İngilizce Dublaj"
            : "Japonca [TR Altyazılı]";

        for (const item of group.items ?? []) {
          if (!item.link) continue;
          const qVal = Number(item.quality) || 1080;
          const qLabel =
            qVal >= 2160 ? "2160p" : qVal >= 1440 ? "1440p" : `${qVal}p`;
          streams.push(
            createStream({
              url: item.link,
              kind: item.type === "hls" ? "hls" : "mp4",
              quality: qLabel,
              label: `Anizium • ${groupLabel} [${qLabel}]`,
              audioType,
              language,
              headers: streamHeaders,
              subtitles,
            }),
          );
        }
      }

      return finalizeStreams(streams);
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
