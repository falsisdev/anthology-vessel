import { crypto } from "vessel";
import type { StreamCandidate, SubtitleTrack } from "vessel";
import { configString } from "../config.ts";
import { buildHeaders, fetchJson, fetchText } from "../http.ts";
import { pickBestCandidate } from "../plugin-helpers.ts";
import { createStream } from "../quality.ts";
import { dedupeStrings, extractYear } from "../text.ts";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";
import { extractVixolity } from "../../extractors/vixolity.ts";

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
