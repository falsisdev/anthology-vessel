import type { StreamCandidate, SubtitleTrack } from "vessel";
import { DEFAULT_USER_AGENT, fetchText } from "../core/http.ts";
import { createStream } from "../core/quality.ts";

export const VIXOLITY_HEADERS: Record<string, string> = {
  "User-Agent": DEFAULT_USER_AGENT,
  Referer: "https://pl.vixolity.com/",
  Origin: "https://pl.vixolity.com",
  Accept: "*/*",
};

export function parseVixolitySubtitles(playlistText: string): SubtitleTrack[] {
  const subs: SubtitleTrack[] = [];
  const subRe =
    /#EXT-X-MEDIA:TYPE=SUBTITLES[^\n]*?NAME="([^"]+)"[^\n]*?LANGUAGE="([^"]+)"[^\n]*?URI="([^"]+)"/gi;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = subRe.exec(playlistText)) !== null) {
    const label = match[1] ?? "Altyazı";
    const lang = (match[2] ?? "tr").toLowerCase();
    const uri = match[3] ?? "";
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    subs.push({
      id: lang,
      source: {
        kind: "url",
        url: uri,
        headers: VIXOLITY_HEADERS,
      },
      lang,
      label,
      format: "vtt",
      isDefault: lang === "tr",
    });
  }

  return subs;
}

export async function extractVixolity(opts: {
  imdbId: string;
  season?: number;
  episode?: number;
  baseUrl?: string;
  sourceLabel?: string;
}): Promise<{ streams: StreamCandidate[]; subtitles: SubtitleTrack[] }> {
  const imdb = opts.imdbId.trim();
  if (!/^tt\d+$/i.test(imdb)) return { streams: [], subtitles: [] };

  const base = (opts.baseUrl ?? "https://ha.vixolity.com").replace(/\/+$/, "");
  const targetUrl =
    opts.season && opts.episode
      ? `${base}/vs/${imdb}/s${opts.season}/e${opts.episode}`
      : `${base}/vs/${imdb}`;

  const body = await fetchText(targetUrl, {
    timeoutMs: 10_000,
    headers: VIXOLITY_HEADERS,
  });
  if (!body || !body.includes("#EXTM3U")) {
    return { streams: [], subtitles: [] };
  }

  const subtitles = parseVixolitySubtitles(body);
  const labelPrefix = opts.sourceLabel ? `${opts.sourceLabel} • ` : "Vixolity • ";
  const hasTr =
    /NAME="Turkish"|LANGUAGE="tr"|NAME="Türkçe"/i.test(body) ||
    subtitles.some((s) => s.lang === "tr");

  const stream = createStream({
    url: targetUrl,
    kind: "hls",
    quality: "1080p",
    label: `${labelPrefix}${hasTr ? "Çift Ses (TR & Orijinal)" : "1080p Master"} • HLS`,
    audioType: hasTr ? "dub" : "sub",
    language: hasTr ? "tr" : "en",
    flags: ["multi_audio", "subtitled"],
    headers: VIXOLITY_HEADERS,
    subtitles,
  });

  return { streams: [stream], subtitles };
}
