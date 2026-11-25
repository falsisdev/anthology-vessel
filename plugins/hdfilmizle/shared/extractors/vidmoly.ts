import { createStream } from "../core/quality.ts";
import { fetchText } from "../core/http.ts";
import type { AudioType, StreamCandidate } from "vessel";

export interface ExtractorOpts {
  sourceLabel?: string;
  audioType?: AudioType;
  language?: string;
  referer?: string;
}

export async function extractVidmoly(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  let url = rawUrl.trim();
  if (url.startsWith("//")) url = `https:${url}`;
  const idMatch = /(?:embed-|\/dl\/|\/)([a-zA-Z0-9]{8,20})(?:\.html)?/i.exec(url);
  if (url.includes("vidmoly") && idMatch && idMatch[1] && !url.includes("embed-")) {
    url = `https://vidmoly.to/embed-${idMatch[1]}.html`;
  }
  url = url.replace(/vidmoly\.(?:biz|net|me)\//i, "vidmoly.to/");

  const htmlText = await fetchText(url, {
    timeoutMs: 10_000,
    headers: {
      Referer: opts.referer ?? "https://vidmoly.to/",
    },
  });
  if (!htmlText) return [];

  const fileMatch = /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i.exec(htmlText) ??
    /sources\s*:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+)["']/i.exec(htmlText);
  if (!fileMatch || !fileMatch[1]) return [];

  const labelPrefix = opts.sourceLabel ? `${opts.sourceLabel} • ` : "";
  const audioLabel =
    opts.audioType === "dub"
      ? "Türkçe Dublaj"
      : opts.audioType === "sub"
        ? "Türkçe Altyazılı"
        : "VidMoly";

  return [
    createStream({
      url: fileMatch[1],
      kind: "hls",
      quality: "1080p",
      label: `${labelPrefix}${audioLabel} • 1080p HLS`,
      audioType: opts.audioType,
      language: opts.language ?? (opts.audioType === "dub" ? "tr" : undefined),
      headers: {
        Referer: "https://vidmoly.to/",
      },
    }),
  ];
}
