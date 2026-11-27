import type { StreamCandidate } from "vessel";
import { fetchText, postJson } from "../core/http.ts";
import { createStream } from "../core/quality.ts";
import { asciiFold } from "../core/text.ts";

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const ANDROID_YT_UA =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

interface InnertubeResponse {
  streamingData?: {
    hlsManifestUrl?: string;
    formats?: Array<{
      url?: string;
      mimeType?: string;
      qualityLabel?: string;
      height?: number;
    }>;
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    channelId?: string;
    lengthSeconds?: string;
  };
}

export interface ResolvedYouTubeVideo {
  streams: StreamCandidate[];
  videoTitle?: string;
  author?: string;
  durationSec: number;
}

export async function extractYouTubeId(rawUrlOrId: string): Promise<string | null> {
  const input = rawUrlOrId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const m =
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|[?&]id=)([a-zA-Z0-9_-]{11})/.exec(
      input,
    );
  return m?.[1] ?? null;
}

export async function resolveYouTubeInnertube(
  rawUrlOrId: string,
  sourceLabel = "YouTube Resmi",
): Promise<ResolvedYouTubeVideo | null> {
  const videoId = await extractYouTubeId(rawUrlOrId);
  if (!videoId) return null;

  const data = await postJson<InnertubeResponse>(
    `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
    {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "20.10.38",
        },
      },
      videoId,
    },
    {
      timeoutMs: 7_000,
      headers: {
        "User-Agent": ANDROID_YT_UA,
      },
    },
  );
  if (!data?.streamingData) return null;

  const ytHeaders = { "User-Agent": ANDROID_YT_UA };
  const streams: StreamCandidate[] = [];

  if (data.streamingData.hlsManifestUrl) {
    streams.push(
      createStream({
        url: data.streamingData.hlsManifestUrl,
        kind: "hls",
        quality: "1080p",
        label: `${sourceLabel} • 1080p HLS`,
        audioType: "original",
        language: "tr",
        headers: ytHeaders,
      }),
    );
  }

  for (const fmt of data.streamingData.formats ?? []) {
    if (!fmt.url || !(fmt.mimeType ?? "").includes("mp4")) continue;
    const q = fmt.qualityLabel || (fmt.height ? `${fmt.height}p` : "720p");
    streams.push(
      createStream({
        url: fmt.url,
        kind: "mp4",
        quality: q,
        label: `${sourceLabel} • ${q} MP4`,
        audioType: "original",
        language: "tr",
        headers: ytHeaders,
      }),
    );
  }

  if (streams.length === 0) return null;

  return {
    streams,
    videoTitle: data.videoDetails?.title,
    author: data.videoDetails?.author,
    durationSec: Number.parseInt(data.videoDetails?.lengthSeconds ?? "0", 10) || 0,
  };
}

export async function searchOfficialYouTubeEpisode(
  seriesTitle: string,
  episodeNumber: number,
  sourceLabel = "YouTube Resmi",
  minDurationSec = 900,
): Promise<StreamCandidate[]> {
  const q = `${seriesTitle} ${episodeNumber}. bölüm`;
  const htmlText = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    { timeoutMs: 8_000 },
  );
  if (!htmlText) return [];

  const titleFold = asciiFold(seriesTitle);
  const ids: string[] = [];
  const seen = new Set<string>();
  const vidRe = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
  let m: RegExpExecArray | null;
  while ((m = vidRe.exec(htmlText)) !== null && ids.length < 5) {
    const vid = m[1];
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      ids.push(vid);
    }
  }

  const epBoundary = new RegExp(`(?:^|[^0-9])${episodeNumber}(?:[^0-9]|$)`);
  for (const vid of ids) {
    const resolved = await resolveYouTubeInnertube(vid, sourceLabel);
    if (!resolved) continue;
    if (resolved.durationSec > 0 && resolved.durationSec < minDurationSec) continue;
    const vtFold = asciiFold(resolved.videoTitle ?? "");
    if (/fragman|teaser|on izleme|tanitim/.test(vtFold)) continue;
    if (vtFold.includes(titleFold) && epBoundary.test(vtFold)) {
      return resolved.streams;
    }
  }
  return [];
}
