import type { StreamCandidate } from "vessel";
import { configString } from "../config.ts";
import { fetchJson } from "../http.ts";
import { createStream } from "../quality.ts";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";

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
