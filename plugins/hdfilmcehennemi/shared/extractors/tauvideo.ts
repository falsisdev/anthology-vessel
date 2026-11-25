import type { StreamCandidate } from "vessel";
import { fetchJson } from "../core/http.ts";
import { createStream } from "../core/quality.ts";
import type { ExtractorOpts } from "./vidmoly.ts";

interface TauVideoResponse {
  urls?: Array<{ url?: string; label?: string }>;
}

export async function extractTauVideo(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const trimmed = rawUrl.trim();
  const url = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  const match = /tau-video\.xyz\/embed\/([a-zA-Z0-9_-]+)/i.exec(url);
  const tauId = match?.[1];
  if (!tauId) return [];

  const data = await fetchJson<TauVideoResponse>(
    `https://tau-video.xyz/api/video/${tauId}`,
    {
      timeoutMs: 8_000,
      headers: { Referer: opts.referer ?? "https://animecix.tv/" },
    },
  );
  const entries = data?.urls ?? [];
  const prefix = opts.sourceLabel ? `${opts.sourceLabel} • ` : "";
  const out: StreamCandidate[] = [];
  for (const item of entries) {
    if (!item.url) continue;
    const quality = (item.label || "1080p").toLowerCase();
    out.push(
      createStream({
        url: item.url,
        kind: "mp4",
        quality,
        label: `${prefix}TauVideo • ${quality.toUpperCase()} MP4`,
        audioType: opts.audioType,
        language: opts.language,
        headers: { Referer: "https://tau-video.xyz/" },
      }),
    );
  }
  return out;
}
