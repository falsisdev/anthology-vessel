import type { StreamCandidate } from "vessel";
import { fetchText } from "../core/http.ts";
import { createStream } from "../core/quality.ts";
import type { ExtractorOpts } from "./vidmoly.ts";

export async function extractSibnet(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  let url = rawUrl.trim();
  if (url.startsWith("//")) url = `https:${url}`;

  const rawHtml = await fetchText(url, {
    timeoutMs: 9_000,
    headers: { Referer: opts.referer ?? "https://video.sibnet.ru/" },
  });
  if (!rawHtml) return [];

  const match = /player\.src\(\s*\[\s*\{\s*src\s*:\s*["']([^"']+)["']/i.exec(rawHtml);
  if (!match || !match[1]) return [];

  const srcPath = match[1];
  const videoUrl = srcPath.startsWith("http")
    ? srcPath
    : `https://video.sibnet.ru${srcPath.startsWith("/") ? "" : "/"}${srcPath}`;

  const prefix = opts.sourceLabel ? `${opts.sourceLabel} • ` : "";
  return [
    createStream({
      url: videoUrl,
      kind: "mp4",
      quality: "720p",
      label: `${prefix}Sibnet • 720p MP4`,
      audioType: opts.audioType,
      language: opts.language,
      headers: {
        Referer: "https://video.sibnet.ru/",
      },
    }),
  ];
}
