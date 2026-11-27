import { createStream } from "../core/quality.ts";
import { fetchText } from "../core/http.ts";
import type { AudioType, StreamCandidate } from "vessel";

export interface ExtractorOpts {
  sourceLabel?: string;
  audioType?: AudioType;
  language?: string;
  referer?: string;
}

function buildVidmolyCandidates(rawUrl: string): string[] {
  let url = rawUrl.trim();
  if (url.startsWith("//")) url = `https:${url}`;
  const idMatch = /(?:embed-|\/dl\/|\/)([a-zA-Z0-9]{8,20})(?:\.html)?/i.exec(url);
  const vidId = idMatch?.[1];
  const candidates: string[] = [];

  if (url.includes("vidmoly") && vidId && !url.includes("embed-")) {
    candidates.push(`https://vidmoly.biz/embed-${vidId}.html`);
  } else {
    candidates.push(url);
  }

  if (vidId) {
    for (const host of ["vidmoly.biz", "vidmoly.net", "vidmoly.to"]) {
      const candidate = `https://${host}/embed-${vidId}.html`;
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  } else {
    for (const host of ["vidmoly.biz", "vidmoly.net", "vidmoly.to"]) {
      const candidate = url.replace(/vidmoly\.[a-z0-9]+/i, host);
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

export async function extractVidmoly(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const candidates = buildVidmolyCandidates(rawUrl);

  for (const url of candidates) {
    let origin = "https://vidmoly.biz";
    try {
      origin = new URL(url).origin;
    } catch {
      origin = "https://vidmoly.biz";
    }

    const htmlText = await fetchText(url, {
      timeoutMs: 10_000,
      headers: {
        Referer: opts.referer ?? `${origin}/`,
      },
    });
    if (!htmlText) continue;

    const fileMatch =
      /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i.exec(htmlText) ??
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i.exec(
        htmlText,
      ) ??
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+)["']/i.exec(htmlText);
    if (!fileMatch || !fileMatch[1]) continue;

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
          Referer: `${origin}/`,
        },
      }),
    ];
  }

  return [];
}
