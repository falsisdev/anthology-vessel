import { html } from "vessel";
import type { StreamCandidate } from "vessel";
import { fetchText } from "../core/http.ts";
import { createStream } from "../core/quality.ts";
import { decodeHtmlEntities } from "../core/text.ts";
import type { ExtractorOpts } from "./vidmoly.ts";

interface OkRuOptionsPayload {
  flashvars?: {
    metadata?: string;
  };
}

interface OkRuMetadata {
  hlsMasterPlaylistUrl?: string;
  hlsManifestUrl?: string;
  videos?: Array<{ name?: string; url?: string }>;
}

function mapOkQuality(name?: string): string {
  switch ((name ?? "").toLowerCase()) {
    case "ultra":
      return "2160p";
    case "quad":
      return "1440p";
    case "full":
      return "1080p";
    case "hd":
      return "720p";
    case "sd":
      return "480p";
    case "low":
      return "360p";
    case "lowest":
      return "240p";
    default:
      return "720p";
  }
}

export async function extractOkRu(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  let url = rawUrl.trim();
  if (url.startsWith("//")) url = `https:${url}`;
  url = url.replace("odnoklassniki.ru/", "ok.ru/");

  const rawHtml = await fetchText(url, {
    timeoutMs: 10_000,
    headers: { Referer: opts.referer ?? "https://ok.ru/" },
  });
  if (!rawHtml) return [];

  const doc = html.parse(rawHtml);
  const el = doc.selectOne("[data-options]");
  const rawOptions = el?.attr("data-options") ?? "";
  if (!rawOptions) return [];

  let meta: OkRuMetadata | null = null;
  try {
    const outer = JSON.parse(decodeHtmlEntities(rawOptions)) as OkRuOptionsPayload;
    const rawMeta = outer.flashvars?.metadata as unknown;
    if (typeof rawMeta === "string") {
      meta = JSON.parse(rawMeta) as OkRuMetadata;
    } else if (rawMeta && typeof rawMeta === "object") {
      meta = rawMeta as OkRuMetadata;
    }
  } catch {
    return [];
  }
  if (!meta) return [];

  const streams: StreamCandidate[] = [];
  const prefix = opts.sourceLabel ? `${opts.sourceLabel} • ` : "";
  const headers = { Referer: "https://ok.ru/" };

  for (const video of meta.videos ?? []) {
    if (!video.url) continue;
    const quality = mapOkQuality(video.name);
    streams.push(
      createStream({
        url: video.url,
        kind: "mp4",
        quality,
        label: `${prefix}OK.ru • ${quality} MP4`,
        audioType: opts.audioType,
        language: opts.language,
        headers,
      }),
    );
  }

  const hlsUrl = meta.hlsMasterPlaylistUrl ?? meta.hlsManifestUrl;
  if (hlsUrl) {
    streams.push(
      createStream({
        url: hlsUrl,
        kind: "hls",
        quality: "1080p",
        label: `${prefix}OK.ru • 1080p HLS`,
        audioType: opts.audioType,
        language: opts.language,
        headers,
      }),
    );
  }

  return streams;
}
