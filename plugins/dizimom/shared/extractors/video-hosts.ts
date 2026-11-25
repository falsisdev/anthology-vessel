import { unpack } from "vessel";
import type { StreamCandidate, SubtitleTrack } from "vessel";
import {
  DEFAULT_USER_AGENT,
  EXOPLAYER_USER_AGENT,
  fetchJson,
  fetchText,
  postForm,
  safeRequest,
} from "../core/http.ts";
import { createStream } from "../core/quality.ts";
import { decodeHtmlEntities } from "../core/text.ts";
import { extractBysezo } from "./bysezo.ts";
import { extractCloseLoad } from "./closeload.ts";
import { extractOkRu } from "./okru.ts";
import { extractPilavyer } from "./pilavyer.ts";
import { extractSibnet } from "./sibnet.ts";
import { extractVidmoly } from "./vidmoly.ts";
import { extractTauVideo } from "./tauvideo.ts";
import type { ExtractorOpts } from "./vidmoly.ts";
import { resolveYouTubeInnertube } from "./youtube.ts";
export { extractTauVideo };

interface PlayerHashResponse {
  securedLink?: string;
  videoSource?: string;
}

interface VidrameTrack {
  language?: string;
  label?: string;
  fx?: { d?: number[]; k?: string };
}

interface VidmoxyTrack {
  file?: string;
  language?: string;
  label?: string;
}

interface FastplaySubtitle {
  file?: string;
  lang?: string;
  label?: string;
}

interface DailymotionMetadataResponse {
  qualities?: {
    auto?: Array<{ url?: string }>;
  };
}

interface DailymotionApiResponse {
  stream_hls_url?: string;
}

interface MailRuMetaResponse {
  videos?: Array<{ key?: string; url?: string }>;
}

interface RumbleEmbedResponse {
  u?: { hls?: string | { url?: string } };
  ua?: { hls?: { auto?: { url?: string } } };
}

function prefixLabel(opts: ExtractorOpts): string {
  return opts.sourceLabel ? `${opts.sourceLabel} • ` : "";
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  return trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
}

function mapLangCode(raw?: string): string {
  const lower = (raw ?? "tr").toLowerCase();
  if (lower === "tur" || lower === "tr" || lower.includes("turk")) return "tr";
  if (lower === "eng" || lower === "en" || lower.includes("eng")) return "en";
  return lower.slice(0, 2) || "tr";
}

function base64DecodeBinary(input: string): string {
  const normalized = input.replace(/\\\//g, "/").trim();
  try {
    if (typeof atob === "function") return atob(normalized);
  } catch {
    // Ignore malformed base64.
  }
  return "";
}

function rot13(input: string): string {
  return input.replace(/[a-zA-Z]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    }
    if (code >= 97 && code <= 122) {
      return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    }
    return ch;
  });
}

function decodeVidmoxy(encoded: string): string | null {
  const b64 = base64DecodeBinary(encoded);
  if (!b64) return null;
  const reversed = b64.split("").reverse().join("");
  return rot13(reversed);
}

function decodeVidrameXor(data: number[], key: string): string | null {
  if (!data.length || !key) return null;
  let out = "";
  for (let i = 0; i < data.length; i++) {
    const byteVal = data[i];
    if (typeof byteVal !== "number") return null;
    out += String.fromCharCode(
      byteVal ^ key.charCodeAt(i % key.length) ^ ((i * 17 + 13) & 255),
    );
  }
  return out;
}

function decodeSpgCerceve(n: string, o: string): string | null {
  const a = base64DecodeBinary(n);
  const b = base64DecodeBinary(o);
  if (!a || !b) return null;
  let out = "";
  for (let i = 0; i < a.length; i++) {
    out += String.fromCharCode(a.charCodeAt(i) ^ b.charCodeAt(i % b.length));
  }
  const url = out.split("|")[0] ?? "";
  return url.startsWith("http") ? url : null;
}

function extractInlineVttSubtitles(
  htmlText: string,
  headers?: Record<string, string>,
): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'\\]+\.vtt(?:\?[^\s"'\\]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(htmlText)) !== null) {
    const uri = match[0];
    if (!uri || seen.has(uri) || /thumbnails|sprite/i.test(uri)) continue;
    seen.add(uri);
    const lang = /eng/i.test(uri) ? "en" : "tr";
    subs.push({
      id: lang,
      source: { kind: "url", url: uri, headers },
      lang,
      label: lang === "en" ? "English" : "Türkçe",
      format: "vtt",
      isDefault: lang === "tr",
    });
  }
  return subs;
}

export async function extractAnizmPlayer(
  rawUrlOrHash: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const clean = normalizeUrl(rawUrlOrHash);
  const fullMatch =
    /^(https?:\/\/[^/]+)\/(?:video\/|player\/index\.php\?data=)([a-f0-9]{16,64})/i.exec(
      clean,
    );
  const origin = fullMatch?.[1] ?? "https://anizmplayer.com";
  const hash =
    fullMatch?.[2] ?? (/^[a-f0-9]{16,64}$/i.test(clean) ? clean : undefined);
  if (!hash) return [];

  const res = await postForm(
    `${origin}/player/index.php?data=${encodeURIComponent(hash)}&do=getVideo`,
    {
      hash,
      r: opts.referer ?? "https://diziwatch.org/",
    },
    {
      timeoutMs: 8_500,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${origin}/video/${hash}`,
        Origin: origin,
      },
    },
  );
  if (!res || res.status < 200 || res.status >= 300) return [];

  let payload: PlayerHashResponse | null = null;
  try {
    payload = res.json<PlayerHashResponse>();
  } catch {
    return [];
  }

  const streamUrl = payload?.videoSource ?? payload?.securedLink;
  if (!streamUrl || !streamUrl.startsWith("http")) return [];

  const hostTag = origin.includes("asyaanimeleri") ? "AsyaPlayer" : "AnizmPlayer";
  return [
    createStream({
      url: streamUrl,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}${hostTag} • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: { Referer: `${origin}/` },
    }),
  ];
}

export async function extractHdPlayerSystem(
  rawUrlOrHash: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const clean = rawUrlOrHash.trim();
  const hash =
    /^[a-f0-9]{16,64}$/i.test(clean)
      ? clean
      : /hdplayersystem\.com\/(?:video\/|player\/index\.php\?data=)([a-f0-9]{16,64})/i.exec(
          clean,
        )?.[1];
  if (!hash) return [];

  const res = await postForm(
    `https://hdplayersystem.com/player/index.php?data=${encodeURIComponent(hash)}&do=getVideo`,
    {
      hash,
      r: opts.referer ?? "https://animom.org/",
    },
    {
      timeoutMs: 9_000,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://hdplayersystem.com/video/${hash}`,
        Origin: "https://hdplayersystem.com",
      },
    },
  );
  if (!res || res.status < 200 || res.status >= 300) return [];

  let payload: PlayerHashResponse | null = null;
  try {
    payload = res.json<PlayerHashResponse>();
  } catch {
    return [];
  }

  const streamUrl = payload?.securedLink ?? payload?.videoSource;
  if (!streamUrl || !streamUrl.startsWith("http")) return [];

  return [
    createStream({
      url: streamUrl,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}HDPlayer • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: { Referer: "https://hdplayersystem.com/" },
    }),
  ];
}

export async function extractVidpapi(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const url = normalizeUrl(rawUrl);
  const pathPart = url.split("?")[0]?.split("/").filter(Boolean).pop() ?? "";
  const queryId = /[?&]data=([a-zA-Z0-9_-]+)/.exec(url)?.[1];
  const videoId = queryId ?? pathPart;
  if (!videoId) return [];

  const origin = new URL(url).origin;
  const pageRes = await safeRequest(url, {
    timeoutMs: 10_000,
    headers: { Referer: opts.referer ?? `${origin}/` },
  });
  if (!pageRes || pageRes.status < 200 || pageRes.status >= 400) return [];

  const embedHtml = pageRes.text();
  const rawSetCookie =
    pageRes.headers["set-cookie"] ?? pageRes.headers["Set-Cookie"] ?? "";
  const cookieMatch = /fireplayer_player=([^;]+)/.exec(rawSetCookie);

  const headers: Record<string, string> = {
    Referer: url,
    Origin: origin,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookieMatch?.[1]) {
    headers["Cookie"] = `fireplayer_player=${cookieMatch[1]}`;
  }

  const apiRes = await postForm(
    `${origin}/player/index.php?data=${encodeURIComponent(videoId)}&do=getVideo`,
    { data: videoId, do: "getVideo" },
    { timeoutMs: 10_000, headers },
  );
  if (!apiRes || apiRes.status < 200 || apiRes.status >= 300) return [];

  const apiText = apiRes.text();
  const secMatch = /"securedLink"\s*:\s*"([^"]+)"/.exec(apiText);
  const secured = secMatch?.[1]?.replace(/\\\//g, "/");
  if (!secured || !secured.startsWith("http")) return [];

  const subs = extractInlineVttSubtitles(embedHtml, { Referer: `${origin}/` });
  return [
    createStream({
      url: secured,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}Vidpapi • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: { Referer: opts.referer ?? `${origin}/` },
      subtitles: subs,
    }),
  ];
}

export async function extractVidrame(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const url = normalizeUrl(rawUrl);
  const htmlText = await fetchText(url, {
    timeoutMs: 12_000,
    headers: { Referer: opts.referer ?? "https://www.hdfilmizle.vip/" },
  });
  if (!htmlText) return [];

  let streamUrl: string | null = null;
  const srcMatch =
    /sources\s*:\s*\[\{\s*file\s*:\s*\(function[\s\S]*?\)\((\[[^\]]+\])\s*,\s*["']([^"']+)["']\)/i.exec(
      htmlText,
    ) ??
    /\(\s*(\[[0-9,\s]+\])\s*,\s*["']([a-zA-Z0-9]+)["']\s*\)/.exec(htmlText);

  if (srcMatch?.[1] && srcMatch[2]) {
    try {
      const bytes = JSON.parse(srcMatch[1]) as number[];
      streamUrl = decodeVidrameXor(bytes, srcMatch[2]);
    } catch {
      streamUrl = null;
    }
  }
  if (!streamUrl || !streamUrl.startsWith("http")) return [];

  const subtitles: SubtitleTrack[] = [];
  const tracksMatch = /configs\.tracks\s*=\s*(\[[\s\S]*?\]);/.exec(htmlText);
  if (tracksMatch?.[1]) {
    try {
      const tracks = JSON.parse(tracksMatch[1]) as VidrameTrack[];
      for (const t of tracks) {
        if (!t.fx?.d || !t.fx?.k) continue;
        const subUrl = decodeVidrameXor(t.fx.d, t.fx.k);
        if (!subUrl || !subUrl.startsWith("http")) continue;
        const lang = mapLangCode(t.language);
        subtitles.push({
          id: lang,
          source: { kind: "url", url: subUrl },
          lang,
          label: t.label ?? (lang === "en" ? "English" : "Türkçe"),
          format: "vtt",
          isDefault: lang === "tr",
        });
      }
    } catch {
      // Ignore malformed tracks payload.
    }
  }

  return [
    createStream({
      url: streamUrl,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}Vidrame • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: {
        "User-Agent": EXOPLAYER_USER_AGENT,
        Referer: "https://vidrame.pro/",
      },
      subtitles,
    }),
  ];
}

export async function extractVidmoxy(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const url = normalizeUrl(rawUrl);
  const htmlText = await fetchText(url, {
    timeoutMs: 12_000,
    headers: { Referer: opts.referer ?? "https://www.hdfilmizle.vip/" },
  });
  if (!htmlText) return [];

  const eeMatch = /EE\.dd\s*\(\s*["']([^"']+)["']\s*\)/i.exec(htmlText);
  const streamUrl = eeMatch?.[1] ? decodeVidmoxy(eeMatch[1]) : null;
  if (!streamUrl || !streamUrl.startsWith("http")) return [];

  const origin = new URL(url).origin;
  const subtitles: SubtitleTrack[] = [];
  const tracksMatch = /tracks\s*:\s*(\[[\s\S]*?\])/.exec(htmlText);
  if (tracksMatch?.[1]) {
    try {
      const tracks = JSON.parse(tracksMatch[1]) as VidmoxyTrack[];
      for (const t of tracks) {
        if (!t.file || !t.file.includes(".vtt")) continue;
        const subUrl = t.file.startsWith("http")
          ? t.file
          : `${origin}${t.file.startsWith("/") ? "" : "/"}${t.file}`;
        const lang = mapLangCode(t.language);
        subtitles.push({
          id: lang,
          source: { kind: "url", url: subUrl },
          lang,
          label: t.label ?? (lang === "en" ? "English" : "Türkçe"),
          format: "vtt",
          isDefault: lang === "tr",
        });
      }
    } catch {
      // Ignore malformed tracks payload.
    }
  }

  return [
    createStream({
      url: streamUrl,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}Vidmoxy • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: {
        "User-Agent": EXOPLAYER_USER_AGENT,
        Referer: `${origin}/`,
      },
      subtitles,
    }),
  ];
}

export async function extractFastplay(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  let fastplayUrl = normalizeUrl(rawUrl);
  let fastplayReferer = opts.referer ?? fastplayUrl;

  if (fastplayUrl.includes("setplay.")) {
    const spRes = await safeRequest(fastplayUrl, {
      timeoutMs: 12_000,
      headers: { Referer: opts.referer ?? fastplayUrl },
    });
    if (!spRes || spRes.status < 200 || spRes.status >= 400) return [];
    const spHtml = spRes.text();
    const cerMatch =
      /SPG\.cerceve\(\s*"[^"]*"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/.exec(spHtml) ??
      /SPG\.cerceve\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/.exec(spHtml);
    let decodedUrl =
      cerMatch?.[1] && cerMatch[2]
        ? decodeSpgCerceve(cerMatch[1], cerMatch[2])
        : null;
    if (!decodedUrl) {
      const directMatch =
        /https?:\/\/fastplay\.[a-z]+\/stfplay\.php\?[^"'<>\s\\]+/i.exec(spHtml);
      if (directMatch?.[0]) {
        decodedUrl = directMatch[0].replace(/\\+/g, "");
      }
    }
    if (!decodedUrl) return [];
    fastplayReferer = spRes.url || fastplayUrl;
    fastplayUrl = decodedUrl;
  }

  const fpRes = await safeRequest(fastplayUrl, {
    timeoutMs: 12_000,
    headers: { Referer: fastplayReferer },
  });
  if (!fpRes || fpRes.status < 200 || fpRes.status >= 400) return [];

  const fpHtml = fpRes.text();
  const manMatch = /(?:src|stream)\s*:\s*"(\/manifests\/[^"]+)"/.exec(fpHtml);
  if (!manMatch?.[1]) return [];

  const manPath = decodeHtmlEntities(manMatch[1]);
  const fpOrigin = new URL(fastplayUrl).origin;
  const manifestUrl = manPath.startsWith("http") ? manPath : `${fpOrigin}${manPath}`;

  const subtitles: SubtitleTrack[] = [];
  const subBlock = /subtitles\s*:\s*(\[[\s\S]*?\])/.exec(fpHtml);
  if (subBlock?.[1]) {
    try {
      const items = JSON.parse(subBlock[1]) as FastplaySubtitle[];
      for (const item of items) {
        if (!item.file || !item.file.includes(".vtt")) continue;
        const lang = mapLangCode(item.lang);
        subtitles.push({
          id: lang,
          source: { kind: "url", url: item.file },
          lang,
          label: item.label ?? (lang === "en" ? "English" : "Türkçe"),
          format: "vtt",
          isDefault: lang === "tr",
        });
      }
    } catch {
      // Fallback to regex below.
    }
  }
  if (subtitles.length === 0) {
    const subRe =
      /"file"\s*:\s*"(https?:[^"]+\.vtt)"\s*,\s*"label"\s*:\s*"([^"]+)"\s*,\s*"lang"\s*:\s*"([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = subRe.exec(fpHtml)) !== null) {
      if (!m[1]) continue;
      const lang = mapLangCode(m[3]);
      subtitles.push({
        id: lang,
        source: { kind: "url", url: m[1].replace(/\\\//g, "/") },
        lang,
        label: m[2] ?? (lang === "en" ? "English" : "Türkçe"),
        format: "vtt",
        isDefault: lang === "tr",
      });
    }
  }

  return [
    createStream({
      url: manifestUrl,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}FastPlay • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: {
        "User-Agent": EXOPLAYER_USER_AGENT,
        Referer: fpRes.url || fastplayUrl,
      },
      subtitles,
    }),
  ];
}

export async function extractDailymotion(
  rawUrlOrId: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const clean = rawUrlOrId.trim();
  const videoId =
    /^[a-zA-Z0-9]{6,12}$/.test(clean)
      ? clean
      : /(?:daily\.php\?id=|\/video\/)([a-zA-Z0-9]+)/i.exec(clean)?.[1];
  if (!videoId) return [];

  const meta = await fetchJson<DailymotionMetadataResponse>(
    `https://www.dailymotion.com/player/metadata/video/${videoId}`,
    {
      timeoutMs: 8_000,
      headers: { Referer: "https://www.dailymotion.com/" },
    },
  );
  let hlsUrl = meta?.qualities?.auto?.[0]?.url;

  if (!hlsUrl) {
    const api = await fetchJson<DailymotionApiResponse>(
      `https://api.dailymotion.com/video/${videoId}?fields=stream_hls_url`,
      { timeoutMs: 8_000 },
    );
    hlsUrl = api?.stream_hls_url;
  }

  if (!hlsUrl || !hlsUrl.startsWith("http")) return [];

  return [
    createStream({
      url: hlsUrl,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}Dailymotion • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: { Referer: "https://www.dailymotion.com/" },
    }),
  ];
}

export async function extractMailRu(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const url = normalizeUrl(rawUrl);
  const directVid =
    /\/embed\/(\d+)/.exec(url)?.[1] ?? /meta\/(\d+)/.exec(url)?.[1];
  let metaUrl = directVid ? `https://my.mail.ru/+/video/meta/${directVid}` : "";
  const referer = url.startsWith("http") ? url : "https://my.mail.ru/";

  if (!metaUrl) {
    const embHtml = await fetchText(url, {
      timeoutMs: 8_000,
      headers: { Referer: opts.referer ?? "https://my.mail.ru/" },
    });
    const m = embHtml
      ? /metadataUrl["']?\s*:\s*["']([^"']+)["']/.exec(embHtml)?.[1] ??
        /(\/+\/my\.mail\.ru\/\+\/video\/meta\/[^"'\s]+)/.exec(embHtml)?.[1]
      : undefined;
    if (m) metaUrl = normalizeUrl(m);
  }
  if (!metaUrl) return [];

  const data = await fetchJson<MailRuMetaResponse>(metaUrl, {
    timeoutMs: 8_000,
    headers: { Referer: referer },
  });
  const prefix = prefixLabel(opts);
  const out: StreamCandidate[] = [];
  for (const v of data?.videos ?? []) {
    if (!v.url) continue;
    const quality = v.key || "720p";
    out.push(
      createStream({
        url: normalizeUrl(v.url),
        kind: "mp4",
        quality,
        label: `${prefix}Mail.ru • ${quality.toUpperCase()} MP4`,
        audioType: opts.audioType,
        language: opts.language,
        headers: { Referer: referer },
      }),
    );
  }
  return out;
}

export async function extractRumble(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const url = normalizeUrl(rawUrl);
  const vid = /rumble\.com\/embed\/([a-zA-Z0-9]+)/i.exec(url)?.[1];
  if (!vid) return [];

  const data = await fetchJson<RumbleEmbedResponse>(
    `https://rumble.com/embedJS/u3/?request=video&ver=2&v=${vid}`,
    { timeoutMs: 8_000 },
  );
  const rawHls =
    (typeof data?.u?.hls === "string" ? data.u.hls : data?.u?.hls?.url) ??
    data?.ua?.hls?.auto?.url;
  if (!rawHls || !rawHls.startsWith("http")) return [];

  return [
    createStream({
      url: rawHls,
      kind: "hls",
      quality: "1080p",
      label: `${prefixLabel(opts)}Rumble • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language,
      headers: { "User-Agent": DEFAULT_USER_AGENT },
    }),
  ];
}

export async function extractYourUpload(
  rawUrlOrId: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const clean = rawUrlOrId.trim();
  const embedId =
    /yourupload\.com\/(?:embed|watch)\/([^/?#]+)/i.exec(clean)?.[1] ??
    (/^[a-zA-Z0-9_-]{6,24}$/.test(clean) ? clean : undefined);
  if (!embedId) return [];

  return [
    createStream({
      url: `http://www.vidcache.net:8161/${embedId}.mp4`,
      kind: "mp4",
      quality: "720p",
      label: `${prefixLabel(opts)}YourUpload • 720p MP4`,
      audioType: opts.audioType,
      language: opts.language,
      headers: { Referer: opts.referer ?? "https://www.yourupload.com/" },
    }),
  ];
}

export async function extractMp4Upload(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  let url = normalizeUrl(rawUrl);
  const idMatch = /mp4upload\.com\/(?:embed-)?([a-zA-Z0-9]+)/i.exec(url);
  if (idMatch?.[1]) {
    url = `https://www.mp4upload.com/embed-${idMatch[1]}.html`;
  }

  let htmlText = await fetchText(url, {
    timeoutMs: 9_000,
    headers: { Referer: opts.referer ?? "https://www.mp4upload.com/" },
  });
  if (!htmlText) return [];

  let srcMatch = /src\s*:\s*["'](https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)["']/i.exec(
    htmlText,
  );
  if (!srcMatch && /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k/i.test(htmlText)) {
    try {
      const packer = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k[\s\S]*?<\/script>/i.exec(
        htmlText,
      )?.[0];
      if (packer) {
        htmlText = unpack(packer);
        srcMatch = /src\s*:\s*["'](https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)["']/i.exec(
          htmlText,
        );
      }
    } catch {
      // Ignore unpack failure.
    }
  }
  const mp4Url = srcMatch?.[1];
  if (!mp4Url) return [];

  return [
    createStream({
      url: mp4Url,
      kind: "mp4",
      quality: "1080p",
      label: `${prefixLabel(opts)}MP4Upload • 1080p MP4`,
      audioType: opts.audioType,
      language: opts.language,
      headers: { Referer: "https://www.mp4upload.com/" },
    }),
  ];
}

export async function extractByEmbedUrl(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const url = normalizeUrl(rawUrl);
  const lower = url.toLowerCase();

  if (lower.includes("vidmoly.")) return extractVidmoly(url, opts);
  if (lower.includes("ok.ru") || lower.includes("odnoklassniki.ru")) {
    return extractOkRu(url, opts);
  }
  if (lower.includes("sibnet.ru")) return extractSibnet(url, opts);
  if (lower.includes("closeload")) {
    const res = await extractCloseLoad(
      url,
      opts.referer ?? "https://www.hdfilmcehennemi.nl/",
      opts.sourceLabel,
    );
    return res.streams;
  }
  if (lower.includes("pilavyer")) {
    const res = await extractPilavyer({
      playerUrl: url,
      referer: opts.referer ?? url,
      sourceLabel: opts.sourceLabel ?? "Pilavyer",
    });
    return res.streams;
  }
  if (lower.includes("tau-video.xyz")) return extractTauVideo(url, opts);
  if (lower.includes("anizmplayer.com") || lower.includes("asyaanimeleri.pw/video/")) {
    return extractAnizmPlayer(url, opts);
  }
  if (lower.includes("hdplayersystem.com")) return extractHdPlayerSystem(url, opts);
  if (lower.includes("vidpapi.")) return extractVidpapi(url, opts);
  if (lower.includes("vidrame.")) return extractVidrame(url, opts);
  if (lower.includes("vidmoxy.")) return extractVidmoxy(url, opts);
  if (lower.includes("fastplay.") || lower.includes("setplay.")) {
    return extractFastplay(url, opts);
  }
  if (lower.includes("bysezo") || lower.includes("filemoon.") || lower.includes("n1mwq.org")) {
    return extractBysezo(url, opts);
  }
  if (lower.includes("dailymotion.com") || lower.includes("daily.php")) {
    return extractDailymotion(url, opts);
  }
  if (lower.includes("mail.ru")) return extractMailRu(url, opts);
  if (lower.includes("rumble.com")) return extractRumble(url, opts);
  if (lower.includes("yourupload.com")) return extractYourUpload(url, opts);
  if (lower.includes("mp4upload.com")) return extractMp4Upload(url, opts);
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
    const resolved = await resolveYouTubeInnertube(url, opts.sourceLabel);
    return resolved?.streams ?? [];
  }

  return [];
}

export type { ExtractorOpts };
