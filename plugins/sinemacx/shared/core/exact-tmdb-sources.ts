import { crypto, html } from "vessel";
import type { MediaSummary, StreamCandidate, SubtitleTrack } from "vessel";
import { collectAnimeSearchTitles } from "./anime-helpers.ts";
import { configString } from "./config.ts";
import {
  DEFAULT_USER_AGENT,
  buildHeaders,
  fetchJson,
  fetchText,
  postForm,
  safeRequest,
} from "./http.ts";
import { pickBestCandidate } from "./plugin-helpers.ts";
import { createStream, inferStreamKind } from "./quality.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  dedupeStrings,
  extractYear,
  slugify,
  titleSimilarity,
  ultraClean,
} from "./text.ts";
import type { ResolvedTmdbIdentity } from "./tmdb.ts";
import { extractByEmbedUrl, extractTauVideo } from "../extractors/video-hosts.ts";
import { VIXOLITY_HEADERS, extractVixolity } from "../extractors/vixolity.ts";

/* -------------------------------------------------------------------------- */
/*                                  Vidlink                                   */
/* -------------------------------------------------------------------------- */

interface EncDecResponse {
  result?: string;
}

interface VidlinkApiResponse {
  stream?: {
    playlist?: string;
    qualities?: Record<string, { url?: string }>;
  };
}

export async function resolveVidlinkByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season?: number;
  episode?: number;
  mirrorUrl?: string;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  const baseUrl = (
    opts.mirrorUrl?.trim() ||
    (await configString("urls.meta_resolvers.vidlink.base", "https://vidlink.pro"))
  ).replace(/\/+$/, "");

  const enc = await fetchJson<EncDecResponse>(
    `https://enc-dec.app/api/enc-vidlink?text=${encodeURIComponent(String(identity.tmdbId))}`,
    { timeoutMs: 8_000 },
  );
  if (!enc?.result) return [];

  const sNum = opts.season ?? 1;
  const eNum = opts.episode ?? 1;
  const apiUrl =
    identity.mediaType === "series"
      ? `${baseUrl}/api/b/tv/${encodeURIComponent(enc.result)}/${sNum}/${eNum}?multiLang=true`
      : `${baseUrl}/api/b/movie/${encodeURIComponent(enc.result)}?multiLang=true`;

  const data = await fetchJson<VidlinkApiResponse>(apiUrl, {
    timeoutMs: 8_000,
    headers: { Referer: `${baseUrl}/`, Origin: baseUrl },
  });
  const streamObj = data?.stream;
  if (!streamObj) return [];

  const streams: StreamCandidate[] = [];
  if (streamObj.playlist) {
    // Vidlink CDN rejects requests carrying browser User-Agent/Referer (HTTP 428).
    streams.push(
      createStream({
        url: streamObj.playlist,
        kind: "hls",
        quality: "1080p",
        label: "Vidlink • Otomatik HLS (1080p)",
        language: "en",
        headers: { Accept: "*/*" },
      }),
    );
  }
  if (streamObj.qualities) {
    for (const [qKey, qVal] of Object.entries(streamObj.qualities)) {
      if (!qVal?.url) continue;
      const quality = /^\d+$/.test(qKey) ? `${qKey}p` : qKey;
      streams.push(
        createStream({
          url: qVal.url,
          kind: "mp4",
          quality,
          label: `Vidlink • ${quality.toUpperCase()} MP4`,
          language: "en",
          headers: { Accept: "*/*" },
        }),
      );
    }
  }
  return streams;
}

/* -------------------------------------------------------------------------- */
/*                          Anthology Live Go VOD                             */
/* -------------------------------------------------------------------------- */

interface GoVodStreamItem {
  title?: string;
  url?: string;
  quality?: string;
  format?: string;
  isHls?: boolean;
  score?: number;
  headers?: Record<string, string>;
}

interface GoVodResponse {
  streams?: GoVodStreamItem[];
}

export async function resolveGoVodByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season?: number;
  episode?: number;
  customBaseUrl?: string;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  const defaultApi = await configString(
    "urls.vod.anthology_live_api",
    "https://anthology-live.duckdns.org/api/vod/streams",
  );
  const apiBase = opts.customBaseUrl?.trim()
    ? `${opts.customBaseUrl.trim().replace(/\/+$/, "")}/api/vod/streams`
    : defaultApi;

  const qs = new URLSearchParams({
    type: identity.mediaType,
    imdb: identity.imdbId ?? "",
    title: identity.title,
    original_title: identity.originalTitle,
    year: identity.year ? String(identity.year) : "",
  });
  if (identity.mediaType === "series") {
    qs.set("season", String(opts.season ?? 1));
    qs.set("episode", String(opts.episode ?? 1));
  }

  const data = await fetchJson<GoVodResponse>(`${apiBase}?${qs.toString()}`, {
    timeoutMs: 8_000,
    headers: { "User-Agent": DEFAULT_USER_AGENT },
  });

  const streams: StreamCandidate[] = [];
  for (const item of data?.streams ?? []) {
    if (!item.url) continue;
    const isVix = /vixolity\.com/i.test(item.url);
    streams.push(
      createStream({
        url: item.url,
        kind: inferStreamKind(
          item.url,
          item.format ?? (item.isHls || isVix ? "hls" : undefined),
        ),
        quality: item.quality || "1080p",
        label: item.title || `Anthology VOD • ${item.quality || "HD"}`,
        priority: item.score,
        headers:
          item.headers ??
          (isVix ? VIXOLITY_HEADERS : { "User-Agent": DEFAULT_USER_AGENT }),
      }),
    );
  }
  return streams;
}

/* -------------------------------------------------------------------------- */
/*                                HDFilmDelisi                                */
/* -------------------------------------------------------------------------- */

export interface DelisiFilmRecord {
  id?: string | number;
  slug?: string;
  baslik?: string;
  orijinalBaslik?: string;
  title?: string;
  yayinYili?: number | string;
  afis?: string;
  imdbId?: string;
  kategoriler?: Array<{ ad?: string }>;
}

export interface DelisiListResponse {
  results?: DelisiFilmRecord[];
  films?: DelisiFilmRecord[];
}

function vidmodyDecrypt(hex: string, key: number): string {
  try {
    let sb = "";
    for (let i = 0; i < hex.length; i += 2) {
      sb += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
    }
    const rev = sb.split("").reverse().join("");
    const decoded = crypto.base64DecodeBytes(rev);
    let out = "";
    for (let i = 0; i < decoded.length; i++) {
      out += String.fromCharCode(((decoded[i] ?? 0) - key + 256) % 256);
    }
    return out.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
  } catch {
    return "";
  }
}

export async function extractVidmodyEmbed(
  pageUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const pageHtml = await fetchText(pageUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!pageHtml) return [];

  const playerMatch =
    /https?:[\\/]+player\.vidmody\.com[\\/][a-zA-Z0-9=\\/]+/.exec(pageHtml);
  if (!playerMatch?.[0]) return [];
  const playerUrl = playerMatch[0].split("\\").join("/");
  const playerHtml = await fetchText(playerUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(pageUrl),
  });
  if (!playerHtml) return [];

  const dMatch =
    /(?:decrypt|\))\s*\(\s*["']([0-9a-fA-F]+)["']\s*,\s*(\d+)\s*\)/.exec(
      playerHtml,
    );
  if (!dMatch?.[1] || !dMatch[2]) return [];
  const block = vidmodyDecrypt(dMatch[1], Number.parseInt(dMatch[2], 10));
  const fMatch = /file:\s*['"](https?:\/\/[^'"]+)['"]/.exec(block);
  if (!fMatch?.[1]) return [];

  const subs: SubtitleTrack[] = [];
  const seenSub = new Set<string>();
  const subRe = /https?:\/\/[^\s"'\\]+\.vtt/gi;
  let sm: RegExpExecArray | null;
  const combined = `${playerHtml} ${block}`;
  while ((sm = subRe.exec(combined)) !== null) {
    const u = sm[0];
    if (seenSub.has(u) || /thumb/i.test(u)) continue;
    seenSub.add(u);
    const lang = /tur/i.test(u) ? "tr" : "en";
    subs.push({
      id: `${lang}_${subs.length}`,
      source: { kind: "url", url: u, headers: { Referer: playerUrl } },
      lang,
      label: lang === "tr" ? "Türkçe" : "English",
      format: "vtt",
      isDefault: lang === "tr",
    });
  }

  return [
    createStream({
      url: fMatch[1],
      kind: "hls",
      quality: "1080p",
      label: "HDFilmDelisi • Vidmody 1080p HLS",
      headers: buildHeaders("https://player.vidmody.com/"),
      subtitles: subs.length > 0 ? subs : undefined,
    }),
  ];
}

export async function resolveHdFilmDelisiByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season?: number;
  episode?: number;
  base?: string;
  vixBase?: string;
  exactImdbRequired?: boolean;
  includeVixolity?: boolean;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  const streams: StreamCandidate[] = [];

  if (opts.includeVixolity && identity.imdbId?.startsWith("tt")) {
    const vixBase =
      opts.vixBase ??
      (await configString(
        "urls.movies.hdfilmdelisi.vidmody_player",
        "https://ha.vixolity.com",
      ));
    const vix = await extractVixolity({
      imdbId: identity.imdbId,
      season: identity.mediaType === "series" ? (opts.season ?? 1) : undefined,
      episode: identity.mediaType === "series" ? (opts.episode ?? 1) : undefined,
      baseUrl: vixBase,
      sourceLabel: "HDFilmDelisi",
    });
    streams.push(...vix.streams);
    if (streams.length > 0) return streams;
  }

  if (identity.mediaType !== "movie") return streams;

  const base = (
    opts.base ??
    (await configString("urls.movies.hdfilmdelisi.base", "https://hdfilmdelisi.one"))
  ).replace(/\/+$/, "");

  for (const q of dedupeStrings([identity.title, identity.originalTitle]).slice(0, 2)) {
    const sr = await fetchJson<DelisiListResponse>(
      `${base}/api/search?q=${encodeURIComponent(q)}`,
      { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
    );
    const cands = (sr?.results ?? sr?.films ?? [])
      .filter((r) => Boolean(r.slug))
      .map((r) => ({
        title: r.baslik || r.title || "",
        altTitle: r.orijinalBaslik,
        year: extractYear(String(r.yayinYili ?? "")),
        slug: String(r.slug!),
      }));
    const best = pickBestCandidate(
      cands,
      identity.title,
      identity.originalTitle,
      identity.year,
    );
    if (!best) continue;

    if (opts.exactImdbRequired && identity.imdbId) {
      const filmMeta = await fetchJson<DelisiFilmRecord>(
        `${base}/api/films/${encodeURIComponent(best.slug)}`,
        { timeoutMs: 6_000, headers: buildHeaders(`${base}/`) },
      );
      if (filmMeta?.imdbId && filmMeta.imdbId !== identity.imdbId) {
        continue;
      }
    }

    const embeds = await extractVidmodyEmbed(`${base}/film/${best.slug}`, base);
    if (embeds.length > 0) return embeds;
  }

  return streams;
}

/* -------------------------------------------------------------------------- */
/*                                  SinemaCX                                  */
/* -------------------------------------------------------------------------- */

export function parseSinemacxCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const el of doc.select("a[href*='/film/'], article a[href]")) {
    const href = el.attr("href");
    if (!href || !href.includes("/film/")) continue;
    const url = absoluteUrl(base, href);
    if (seen.has(url)) continue;

    const img = el.selectOne("img");
    const rawTitle = el.attr("title") || img?.attr("alt") || el.text().trim();
    const title = decodeHtmlEntities(rawTitle).replace(/\s*izle\s*$/i, "").trim();
    if (!title || title.length < 2) continue;
    seen.add(url);

    const poster = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `movie:${encodeURIComponent(url)}`,
      type: "movie",
      title,
      year: extractYear(title),
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return items;
}

export async function resolveSinemaCxPage(
  pageUrl: string,
  base: string,
  expectedImdbId?: string,
): Promise<StreamCandidate[]> {
  const pageHtml = await fetchText(pageUrl, {
    timeoutMs: 8_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!pageHtml) return [];

  const doc = html.parse(pageHtml);
  if (expectedImdbId) {
    const imdbHref = doc.selectOne('a[href*="imdb.com/title/tt"]')?.attr("href");
    const pageImdb = /tt\d+/.exec(imdbHref ?? "")?.[0];
    if (pageImdb && pageImdb !== expectedImdbId) {
      return [];
    }
  }

  const bodyLower = doc.selectOne("body")?.text().toLowerCase() ?? "";
  const audioType = bodyLower.includes("dublaj")
    ? "dub"
    : bodyLower.includes("altyaz")
      ? "sub"
      : undefined;

  let iframeUrl = "";
  for (const ifr of doc.select("iframe")) {
    let src = ifr.attr("data-vsrc") || ifr.attr("src") || "";
    if (!src) continue;
    if (!/^https?:\/\//i.test(src) && !src.startsWith("//")) {
      try {
        src = crypto.base64Decode(src);
      } catch {
        continue;
      }
    }
    if (src.toLowerCase().includes("filmizle.in")) {
      iframeUrl = absoluteUrl(base, src).split("?")[0] ?? "";
      break;
    }
  }
  if (!iframeUrl) return [];

  const videoId = iframeUrl.split("/").pop()?.split("?")[0] ?? "";
  if (!videoId) return [];
  const res = await postForm(
    `https://player.filmizle.in/player/index.php?data=${encodeURIComponent(videoId)}&do=getVideo`,
    { hash: videoId, r: pageUrl },
    {
      timeoutMs: 6_000,
      headers: {
        Referer: iframeUrl.toLowerCase(),
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!res || res.status < 200 || res.status >= 300) return [];

  try {
    const json = res.json<{ securedLink?: string }>();
    if (!json.securedLink) return [];
    return [
      createStream({
        url: json.securedLink,
        kind: "hls",
        quality: "1080p",
        label:
          audioType === "dub"
            ? "SinemaCX • Türkçe Dublaj 1080p HLS"
            : audioType === "sub"
              ? "SinemaCX • Türkçe Altyazılı 1080p HLS"
              : "SinemaCX • 1080p HLS",
        audioType,
        language: audioType === "dub" ? "tr" : undefined,
        headers: buildHeaders("https://player.filmizle.in/"),
      }),
    ];
  } catch {
    return [];
  }
}

export async function resolveSinemaCxByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  base?: string;
  exactImdbIfPresent?: boolean;
  includeVixolity?: boolean;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  if (identity.mediaType !== "movie") return [];

  const base = (
    opts.base ??
    (await configString("urls.movies.sinemacx.base", "https://sinemacc.com"))
  ).replace(/\/+$/, "");

  let targetUrl = "";
  for (const q of dedupeStrings([identity.originalTitle, identity.title]).slice(0, 2)) {
    const sHtml = await fetchText(
      `${base}/?s=${encodeURIComponent(q)}`,
      { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
    );
    if (!sHtml) continue;
    const cards = parseSinemacxCards(sHtml, base).map((c) => ({
      title: c.title,
      year: c.year,
      url: decodeURIComponent(c.nativeId.replace(/^movie:/, "")),
    }));
    const best = pickBestCandidate(
      cards,
      identity.title,
      identity.originalTitle,
      identity.year,
    );
    if (best) {
      targetUrl = best.url;
      break;
    }
  }

  if (!targetUrl && !opts.exactImdbIfPresent) {
    const fallbackSlug = slugify(identity.originalTitle || identity.title);
    if (fallbackSlug) targetUrl = `${base}/film/${fallbackSlug}/`;
  }

  const streams: StreamCandidate[] = targetUrl
    ? await resolveSinemaCxPage(
        targetUrl,
        base,
        opts.exactImdbIfPresent ? identity.imdbId : undefined,
      )
    : [];

  if (streams.length === 0 && opts.includeVixolity && identity.imdbId) {
    const vix = await extractVixolity({
      imdbId: identity.imdbId,
      sourceLabel: "SinemaCX",
    });
    streams.push(...vix.streams);
  }

  return streams;
}

/* -------------------------------------------------------------------------- */
/*                                  AnimeciX                                  */
/* -------------------------------------------------------------------------- */

export const ANIMECIX_XEH_KEY =
  "7Y2ozlO+QysR5w9Q6Tupmtvl9jJp7ThFH8SB+Lo7NvZjgjqRSqOgcT2v4ISM9sP10LmnlYI8WQ==.xrlyOBFS5BHjQ2Lk";

export function animecixApiHeaders(base: string): Record<string, string> {
  return buildHeaders(`${base}/`, { "x-e-h": ANIMECIX_XEH_KEY });
}

export interface AnimecixTitleItem {
  id: number;
  name?: string;
  name_english?: string;
  poster?: string;
  backdrop?: string;
  description?: string;
  type?: string;
  is_series?: boolean;
  tmdb_id?: number | string;
  year?: number;
  episode_count?: number;
  seasons?: Array<{ number?: number; episode_count?: number }>;
}

interface AnimecixSearchResponse {
  results?: AnimecixTitleItem[];
}

export async function resolveAnimecixBestVideo(
  base: string,
  titleId: string,
  season: number,
  episode: number,
): Promise<StreamCandidate[]> {
  const res = await safeRequest(
    `${base}/secure/best-video?titleId=${encodeURIComponent(titleId)}&episode=${episode}&season=${season}`,
    {
      timeoutMs: 10_000,
      headers: animecixApiHeaders(base),
    },
  );
  if (!res) return [];
  for (const cand of [res.url, res.text()].filter(Boolean)) {
    const m =
      /(https?:\/\/(?:[a-z0-9-]+\.)?tau-video\.xyz\/embed\/[a-zA-Z0-9_-]+)/i.exec(
        cand,
      );
    if (m?.[1]) {
      return extractTauVideo(m[1], {
        sourceLabel: "AnimeciX",
        audioType: "sub",
        language: "ja",
        referer: `${base}/`,
      });
    }
  }
  return [];
}

export async function resolveAnimecixByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season: number;
  episode: number;
  base?: string;
  exactTmdbOnly?: boolean;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  const base = (
    opts.base ??
    (await configString("urls.anime.animecix.base", "https://animecix.tv"))
  ).replace(/\/+$/, "");

  const queries = dedupeStrings([
    identity.title,
    identity.originalTitle,
    ...identity.searchTitles.slice(0, 2),
  ]).slice(0, 3);

  for (const q of queries) {
    const res = await fetchJson<AnimecixSearchResponse>(
      `${base}/secure/search/${encodeURIComponent(q)}?limit=12`,
      { timeoutMs: 8_000, headers: animecixApiHeaders(base) },
    );
    const list = res?.results ?? [];
    const exactTmdb = list.find(
      (item) =>
        item.tmdb_id !== undefined &&
        item.tmdb_id !== null &&
        String(item.tmdb_id) === String(identity.tmdbId),
    );
    const matched =
      exactTmdb ??
      (opts.exactTmdbOnly
        ? undefined
        : list.find((item) => {
            const c = ultraClean(item.name || item.name_english || "");
            const qc = ultraClean(q);
            return Boolean(
              c &&
                qc &&
                (c.includes(qc) || qc.includes(c) || titleSimilarity(c, qc) >= 0.65),
            );
          }));
    if (matched) {
      const isMovie = matched.type === "movie" || matched.is_series === false;
      const streams = await resolveAnimecixBestVideo(
        base,
        String(matched.id),
        isMovie ? 1 : opts.season,
        isMovie ? 1 : opts.episode,
      );
      if (streams.length > 0) return streams;
    }
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/*                                  SeiCode                                   */
/* -------------------------------------------------------------------------- */

export const SEICODE_TMDB_MAP: Record<string, string> = {
  "30984": "bleach",
  "30991": "cowboy-bebop",
  "45790": "jojos-bizarre-adventure",
  "56568": "nana",
  "62602": "blue-spring-ride",
  "62640": "nisekoi",
  "63926": "one-punch-man",
  "65942": "re-zero-starting-life-in-another-world-",
  "66348": "re-zero-kara-hajimeru-break-time",
  "72517": "classroom-of-the-elite",
  "76758": "hinamatsuri",
  "78483": "kakuriyo-bed-breakfast-for-spirits-",
  "79166": "grand-blue-dreaming",
  "80564": "banana-fish",
  "82684": "that-time-i-got-reincarnated-as-a-slime",
  "82739": "rascal-does-not-dream-of-bunny-girl-senpai",
  "83121": "kaguya-sama-love-is-war",
  "85937": "demon-slayer-kimetsu-no-yaiba",
  "86034": "arifureta-from-commonplace-to-worlds-strongest",
  "88040": "given",
  "91768": "ascendance-of-a-bookworm",
  "91801": "welcome-to-demon-school-iruma-kun",
  "93241": "uzumaki",
  "94664": "mushoku-tensei-jobless-reincarnation",
  "95269": "toilet-bound-hanako-kun",
  "95479": "jujutsu-kaisen",
  "96316": "rent-a-girlfriend",
  "97525": "to-your-eternity",
  "97782": "kuma-kuma-kuma-bear",
  "100281": "moriarty-the-patriot",
  "100436": "akudama-drive",
  "107255": "dragon-raja-the-blazing-dawn-",
  "110837": "bungo-stray-dogs-wan",
  "111576": "shadows-house",
  "113808": "seirei-gensouki-spirit-chronicles",
  "117465": "hells-paradise",
  "120089": "spy-x-family",
  "123249": "my-dress-up-darling",
  "123542": "link-click",
  "127532": "solo-leveling",
  "130237": "aharen-san-wa-hakarenai",
  "131041": "blue-lock",
  "153217": "sparks-of-tomorrow",
  "154526": "mf-ghost",
  "154716": "link-click-the-daily-life-in-lightime",
  "154743": "the-angel-next-door-spoils-me-rotten",
  "196285": "farming-life-in-another-world",
  "196950": "witch-hat-atelier",
  "203737": "oshi-no-ko",
  "204266": "trigun-stampede",
  "205050": "shangri-la-frontier",
  "205743": "no-longer-allowed-in-another-world",
  "206799": "dark-gathering",
  "207332": "sakamoto-days",
  "207347": "blue-box",
  "213402": "campfire-cooking-in-another-world-with-my-absurd-skill",
  "216074": "25-dimensional-seduction",
  "216467": "mission-yozakura-family",
  "216523": "ron-kamonohashis-forbidden-deductions",
  "217407": "can-a-boy-girl-friendship-survive",
  "217409": "april-showers-bring-may-flowers",
  "220286": "ishura",
  "220542": "the-apothecary-diaries",
  "222623": "the-elusive-samurai",
  "223564": "the-100-girlfriends-who-really-really-really-really-really-love-you",
  "229858": "fate-strange-fake",
  "230189": "365-days-to-the-wedding",
  "231003": "lazarus",
  "231873": "oblivion-battery",
  "232230": "lord-of-mysteries",
  "232252": "delicos-nursery",
  "234538": "demon-lord-2099",
  "234776": "blue-miburo",
  "234910": "tying-the-knot-with-an-amagami-sister",
  "239761": "senpai-is-an-otokonoko",
  "239779": "true-beauty",
  "241535": "makeine-too-many-losing-heroines",
  "242143": "you-are-ms-servant",
  "244624": "the-do-over-damsel-conquers-the-dragon-emperor",
  "245285": "failure-frame-i-became-the-strongest-and-annihilated-everything-with-low-level-spells",
  "245325": "the-richest-man-in-game",
  "245842": "wistoria-wand-and-sword",
  "247045": "nyaight-of-the-living-cat",
  "247859": "honey-lemon-soda",
  "249882": "zenshu",
  "249907": "sentenced-to-be-a-hero",
  "249964": "i-may-be-a-guild-receptionist-but-ill-solo-any-boss-to-clock-out-on-time",
  "250596": "my-wife-has-no-emotion",
  "250994": "ameku-md-doctor-detective",
  "253476": "journal-with-witch",
  "254492": "hana-kimi",
  "254987": "dead-dead-demons-dededede-destruction",
  "256721": "gachiakuta",
  "256744": "flower-and-asura",
  "257603": "tsumasho",
  "258228": "momentary-lily",
  "258348": "clevatess",
  "258578": "promise-of-wizard",
  "258580": "the-most-notorious-talker-runs-the-worlds-greatest-clan",
  "258680": "anyway-im-falling-in-love-with-you",
  "258994": "medaka-kuroiwa-is-impervious-to-my-charms",
  "259559": "headhunted-to-another-world-from-salaryman-to-big-four",
  "259787": "yakuza-fiance-raise-wa-tanin-ga-ii",
  "259819": "rooster-fighter",
  "260463": "daemons-of-the-shadow-realm",
  "260523": "rock-is-a-ladys-modesty",
  "260823": "from-old-country-bumpkin-to-master-swordsman",
  "261298": "possibly-the-greatest-alchemist-of-all-time",
  "261311": "i-want-to-escape-from-princess-lessons",
  "261343": "chitose-is-in-the-ramune-bottle",
  "262141": "i-have-a-crush-at-work",
  "263330": "shiboyugi-playing-death-games-to-put-food-on-the-table",
  "270603": "the-exiled-heavy-knight-knows-how-to-game-the-system",
  "271605": "may-i-ask-for-one-final-thing",
  "271609": "dark-moon-the-blood-altar",
  "272059": "to-be-hero-x",
  "273467": "the-warrior-princess-and-the-barbaric-king",
  "274069": "kowloon-generic-romance",
  "274671": "the-beginning-after-the-end",
  "274741": "the-too-perfect-saint-tossed-aside-by-my-fiance-and-sold-to-another-kingdom",
  "276204": "bogus-skill-fruitmaster-about-that-time-i-became-able-to-eat-unlimited-numbers-of-skill-fruits-that-kill-you",
  "276253": "the-brilliant-healers-new-life-in-the-shadows",
  "277513": "theres-no-freaking-way-ill-be-your-lover-unless",
  "277665": "anne-shirley",
  "278043": "you-and-i-are-polar-opposites",
  "278196": "the-summer-hikaru-died",
  "278604": "gnosia",
  "278635": "my-gift-lvl-9999-unlimited-gacha-backstabbed-in-a-backwater-dungeon-im-out-for-revenge",
  "278816": "the-gorilla-gods-go-to-girl",
  "279182": "super-cube",
  "279216": "the-dinner-table-detective",
  "280049": "hell-mode-the-hardcore-gamer-dominates-in-another-world-with-garbage-balancing",
  "280078": "the-all-devouring-whale-homecoming",
  "281161": "noble-reincarnation-born-blessed-so-ill-obtain-ultimate-power",
  "281199": "legend-of-princess-chang-ge",
  "282946": "kunon-the-sorcerer-can-see",
  "282984": "nmeneko",
  "283360": "classicstars",
  "283428": "the-ramparts-of-ice",
  "283891": "the-holy-grail-of-eris",
  "284029": "the-cat-and-the-dragon",
  "284432": "scum-of-the-brave",
  "284444": "champignon-witch",
  "284495": "isekai-office-worker-the-other-worlds-books-depend-on-the-bean-counter",
  "284644": "my-status-as-an-assassin-obviously-exceeds-the-heros",
  "285166": "jack-of-all-trades-party-of-none",
  "285291": "reincarnated-as-a-dragon-hatchling",
  "285356": "watari-kuns-is-about-to-collapse",
  "285574": "i-want-to-love-you-till-your-dying-day",
  "285743": "you-cant-be-in-a-rom-com-with-your-childhood-friends",
  "285818": "mistress-kanan-is-devilishly-easy",
  "285933": "tune-in-to-the-midnight-heart",
  "286291": "dead-account",
  "286345": "though-i-am-an-inept-villainess",
  "287278": "mechanical-marie",
  "287591": "in-the-clear-moonlit-dusk",
  "288551": "the-klutzy-class-monitor-and-the-girl-with-the-short-skirt",
  "288659": "agents-of-the-four-seasons-dance-of-spring",
  "288971": "jaadugar-a-witch-in-mongolia",
  "290019": "i-made-friends-with-the-second-prettiest-girl-in-my-class",
  "293144": "wash-it-all-away",
  "293697": "i-want-to-end-this-love-game",
  "295071": "goodbye-lara",
  "295366": "there-was-a-cute-girl-in-the-heros-party-so-i-tried-confessing-to-her",
  "295999": "mao",
  "296286": "smoking-behind-the-supermarket-with-you",
  "296851": "si-vis-the-sound-of-heroes",
  "297438": "akane-banashi",
  "298831": "a-livid-ladys-guide-to-getting-even-how-i-crushed-my-homeland-with-my-mighty-grimoires",
  "300126": "liar-game",
  "300131": "kill-blue",
  "300267": "the-worlds-strongest-rearguard",
  "301944": "marriage-toxin",
  "304820": "always-a-catch",
  "309163": "gals-cant-be-kind-to-otaku",
  "309974": "love-unseen-beneath-the-clear-night-sky",
  "310921": "monster-eater",
  "312474": "nippon-sangoku-the-three-nations-of-the-crimson-sun",
  "312849": "rich-girl-caretaker-im-secretly-the-caregiver-of-the-most-popular-girl-in-this-rich-kid-school",
  "312949": "chainsmoker-cat",
};

export interface SeicodeEpisode {
  episode_number?: number | string;
  video_links?: Record<string, string>;
}

export interface SeicodeSeason {
  season_number?: number | string;
  episodes?: SeicodeEpisode[];
}

export interface SeicodeAnimeItem {
  slug?: string;
  english?: string;
  summary?: string;
  tmdbID?: number | string;
  genres?: string[];
  pictures?: { avatar?: string; banner?: string };
  seasons?: SeicodeSeason[];
}

export function matchSeicodeEpisode(
  seasons: SeicodeSeason[],
  targetSeason: number,
  targetEpisode: number,
): SeicodeEpisode | null {
  for (const s of seasons) {
    if ((Number(s.season_number) || 1) === targetSeason) {
      const hit = s.episodes?.find((e) => Number(e.episode_number) === targetEpisode);
      if (hit) return hit;
    }
  }
  if (seasons.length === 1) {
    const solo = seasons[0]?.episodes?.find((e) => Number(e.episode_number) === targetEpisode);
    if (solo) return solo;
  }
  for (const s of seasons) {
    const anyMatch = s.episodes?.find((e) => Number(e.episode_number) === targetEpisode);
    if (anyMatch) return anyMatch;
  }
  return (
    seasons.find((s) => (Number(s.season_number) || 1) === targetSeason)?.episodes?.[0] ??
    seasons[0]?.episodes?.[0] ??
    null
  );
}

export async function resolveSeicodeSlug(opts: {
  slug: string;
  apiBase: string;
  base: string;
  season: number;
  episode: number;
}): Promise<StreamCandidate[]> {
  const detail = await fetchJson<SeicodeAnimeItem>(
    `${opts.apiBase}/anime/${encodeURIComponent(opts.slug)}`,
    { timeoutMs: 8_000, headers: buildHeaders(`${opts.base}/`) },
  );
  const ep = detail?.seasons
    ? matchSeicodeEpisode(detail.seasons, opts.season, opts.episode)
    : null;
  const links = ep?.video_links ?? {};
  const urls = Object.values(links)
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter((u) => u.startsWith("http") || u.startsWith("//"));

  const results = await Promise.all(
    urls.map((u) =>
      extractByEmbedUrl(u, {
        sourceLabel: "SeiCode",
        audioType: "sub",
        language: "ja",
        referer: `${opts.base}/`,
      }),
    ),
  );
  const merged: StreamCandidate[] = [];
  for (const r of results) merged.push(...r);
  return merged;
}

export async function resolveSeicodeByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season: number;
  episode: number;
  apiBase?: string;
  base?: string;
  exactTmdbOnly?: boolean;
}): Promise<StreamCandidate[]> {
  const apiBase = (
    opts.apiBase ??
    (await configString("urls.anime.seicode.api_base", "https://next.seicode.net"))
  ).replace(/\/+$/, "");
  const base = (
    opts.base ?? (await configString("urls.anime.seicode.base", "https://seicode.net"))
  ).replace(/\/+$/, "");

  const tmdbKey = String(opts.identity.tmdbId);
  let slug = SEICODE_TMDB_MAP[tmdbKey] ?? "";

  if (!slug) {
    for (const q of collectAnimeSearchTitles(opts.identity).slice(0, 4)) {
      const hits = await fetchJson<SeicodeAnimeItem[]>(
        `${apiBase}/anime/search?q=${encodeURIComponent(q)}`,
        { timeoutMs: 7_000, headers: buildHeaders(`${base}/`) },
      );
      const exact = (hits ?? []).find((x) => {
        if (!x.slug) return false;
        if (x.tmdbID !== undefined && String(x.tmdbID) === tmdbKey) return true;
        return !opts.exactTmdbOnly && ultraClean(x.english || "") === ultraClean(q);
      });
      if (exact?.slug) {
        slug = exact.slug;
        break;
      }
    }
  }

  if (!slug) return [];
  return resolveSeicodeSlug({
    slug,
    apiBase,
    base,
    season: opts.season,
    episode: opts.episode,
  });
}

/* -------------------------------------------------------------------------- */
/*                                  SonAnime                                  */
/* -------------------------------------------------------------------------- */

export interface SonAnimeEpisode {
  anime_season?: number | string;
  episode_number?: number | string;
  upload_date?: string;
  episode_link_1080?: string;
  episode_link_720?: string;
  episode_link_480?: string;
  episode_link_360?: string;
}

export interface SonAnimeDetail {
  anime_link?: string;
  anime_name?: string;
  anime_name_en?: string;
  anime_type?: string;
  anime_photo?: string;
  anime_description?: string;
  anime_genres?: string[] | string;
  tmdb_id?: number | string;
  episodes?: SonAnimeEpisode[];
}

export function mapSonAnimeEpisodeStreams(
  ep: SonAnimeEpisode,
  base: string,
): StreamCandidate[] {
  const out: StreamCandidate[] = [];
  const entries: Array<[string | undefined, string]> = [
    [ep.episode_link_1080, "1080p"],
    [ep.episode_link_720, "720p"],
    [ep.episode_link_480, "480p"],
    [ep.episode_link_360, "360p"],
  ];
  for (const [url, q] of entries) {
    if (!url?.trim()) continue;
    out.push(
      createStream({
        url: url.trim(),
        kind: "mp4",
        quality: q,
        label: `SonAnime • Türkçe Altyazılı [${q}]`,
        audioType: "sub",
        language: "ja",
        headers: { Referer: `${base}/` },
      }),
    );
  }
  return out;
}

export async function resolveSonAnimeSlug(opts: {
  slug: string;
  apiBase: string;
  base: string;
  isMovie: boolean;
  season: number;
  episode: number;
}): Promise<StreamCandidate[]> {
  const detail = await fetchJson<SonAnimeDetail>(
    `${opts.apiBase}/api/anime/link/${encodeURIComponent(opts.slug)}`,
    { timeoutMs: 8_000, headers: buildHeaders(`${opts.base}/`) },
  );
  const eps = detail?.episodes ?? [];
  if (eps.length === 0) return [];

  const targetEp = opts.isMovie
    ? eps[0]
    : eps.find(
        (e) =>
          (Number(e.anime_season) || 1) === opts.season &&
          (Number(e.episode_number) || 1) === opts.episode,
      ) ?? eps.find((e) => (Number(e.episode_number) || 1) === opts.episode);

  return targetEp ? mapSonAnimeEpisodeStreams(targetEp, opts.base) : [];
}

export async function resolveSonAnimeByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  season: number;
  episode: number;
  apiBase?: string;
  base?: string;
  exactTmdbOnly?: boolean;
}): Promise<StreamCandidate[]> {
  const apiBase = (
    opts.apiBase ??
    (await configString("urls.anime.sonanime.api_base", "https://api.sonanime.com"))
  ).replace(/\/+$/, "");
  const base = (
    opts.base ?? (await configString("urls.anime.sonanime.base", "https://sonanime.com"))
  ).replace(/\/+$/, "");

  const tmdbKey = String(opts.identity.tmdbId);
  let slug = "";
  const allCands: Array<SonAnimeDetail & { title: string }> = [];

  for (const q of collectAnimeSearchTitles(opts.identity).slice(0, 4)) {
    const hits = await fetchJson<SonAnimeDetail[]>(
      `${apiBase}/api/anime/search?q=${encodeURIComponent(q)}`,
      { timeoutMs: 7_000, headers: buildHeaders(`${base}/`) },
    );
    for (const h of hits ?? []) {
      if (!h.anime_link) continue;
      if (h.tmdb_id !== undefined && String(h.tmdb_id) === tmdbKey) {
        slug = h.anime_link;
        break;
      }
      if (!opts.exactTmdbOnly) {
        allCands.push({ ...h, title: h.anime_name || h.anime_name_en || "" });
      }
    }
    if (slug) break;
  }

  if (!slug && !opts.exactTmdbOnly && allCands.length > 0) {
    const best = pickBestCandidate(
      allCands,
      opts.identity.title,
      opts.identity.originalTitle,
    );
    if (best?.anime_link) slug = best.anime_link;
  }

  if (!slug) return [];
  return resolveSonAnimeSlug({
    slug,
    apiBase,
    base,
    isMovie: opts.identity.mediaType === "movie",
    season: opts.season,
    episode: opts.episode,
  });
}
