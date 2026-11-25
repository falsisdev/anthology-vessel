import { crypto } from "vessel";
import type { StreamCandidate, SubtitleTrack } from "vessel";
import { fetchJson } from "../core/http.ts";
import { createStream, inferStreamKind } from "../core/quality.ts";
import type { ExtractorOpts } from "./vidmoly.ts";

interface ByseSource {
  quality?: string;
  label?: string;
  mime_type?: string;
  url?: string;
  height?: number;
}

interface ByseTrack {
  file?: string;
  url?: string;
  kind?: string;
  label?: string;
  lang?: string;
}

interface BysePlayback {
  algorithm?: string;
  iv?: string;
  payload?: string;
  key_parts?: string[];
  version?: string | number;
}

interface ByseVideoResponse {
  sources?: ByseSource[];
  tracks?: ByseTrack[];
  playback?: BysePlayback;
}

interface ByseDetailsResponse {
  embed_frame_url?: string;
}

const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];

function xtime(x: number): number {
  return ((x << 1) ^ ((x & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
}

function expandAes256Key(key: Uint8Array): Uint8Array {
  const rk = new Uint8Array(240);
  rk.set(key.subarray(0, 32));
  let bytesGenerated = 32;
  let rconIdx = 0;
  while (bytesGenerated < 240) {
    let t0 = rk[bytesGenerated - 4]!;
    let t1 = rk[bytesGenerated - 3]!;
    let t2 = rk[bytesGenerated - 2]!;
    let t3 = rk[bytesGenerated - 1]!;
    if (bytesGenerated % 32 === 0) {
      const nt0 = AES_SBOX[t1]! ^ AES_RCON[rconIdx]!;
      t1 = AES_SBOX[t2]!;
      t2 = AES_SBOX[t3]!;
      t3 = AES_SBOX[t0]!;
      t0 = nt0;
      rconIdx += 1;
    } else if (bytesGenerated % 32 === 16) {
      t0 = AES_SBOX[t0]!;
      t1 = AES_SBOX[t1]!;
      t2 = AES_SBOX[t2]!;
      t3 = AES_SBOX[t3]!;
    }
    rk[bytesGenerated] = rk[bytesGenerated - 32]! ^ t0;
    rk[bytesGenerated + 1] = rk[bytesGenerated - 31]! ^ t1;
    rk[bytesGenerated + 2] = rk[bytesGenerated - 30]! ^ t2;
    rk[bytesGenerated + 3] = rk[bytesGenerated - 29]! ^ t3;
    bytesGenerated += 4;
  }
  return rk;
}

function aes256EncryptBlock(block: Uint8Array, rk: Uint8Array): Uint8Array {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i]! ^ rk[i]!;

  for (let round = 1; round <= 14; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]!]!;

    let tmp = s[1]!;
    s[1] = s[5]!;
    s[5] = s[9]!;
    s[9] = s[13]!;
    s[13] = tmp;

    tmp = s[2]!;
    s[2] = s[10]!;
    s[10] = tmp;
    tmp = s[6]!;
    s[6] = s[14]!;
    s[14] = tmp;

    tmp = s[15]!;
    s[15] = s[11]!;
    s[11] = s[7]!;
    s[7] = s[3]!;
    s[3] = tmp;

    if (round < 14) {
      for (let col = 0; col < 16; col += 4) {
        const a0 = s[col]!;
        const a1 = s[col + 1]!;
        const a2 = s[col + 2]!;
        const a3 = s[col + 3]!;
        const t = a0 ^ a1 ^ a2 ^ a3;
        s[col] = a0 ^ t ^ xtime(a0 ^ a1);
        s[col + 1] = a1 ^ t ^ xtime(a1 ^ a2);
        s[col + 2] = a2 ^ t ^ xtime(a2 ^ a3);
        s[col + 3] = a3 ^ t ^ xtime(a3 ^ a0);
      }
    }

    const rOff = round * 16;
    for (let i = 0; i < 16; i++) s[i] = s[i]! ^ rk[rOff + i]!;
  }
  return s;
}

function gfMul128(x: Uint8Array, y: Uint8Array): Uint8Array {
  const z = new Uint8Array(16);
  const v = new Uint8Array(y);
  for (let i = 0; i < 128; i++) {
    if (((x[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0) {
      for (let j = 0; j < 16; j++) z[j] = z[j]! ^ v[j]!;
    }
    const lsb = v[15]! & 1;
    for (let j = 15; j > 0; j--) {
      v[j] = (v[j]! >>> 1) | ((v[j - 1]! & 1) << 7);
    }
    v[0] = v[0]! >>> 1;
    if (lsb !== 0) v[0] = v[0]! ^ 0xe1;
  }
  return z;
}

function ghash(h: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  let y: Uint8Array = new Uint8Array(16);
  for (let off = 0; off < ciphertext.length; off += 16) {
    const end = Math.min(off + 16, ciphertext.length);
    for (let i = off; i < end; i++) {
      y[i - off] = y[i - off]! ^ ciphertext[i]!;
    }
    y = gfMul128(y, h);
  }
  const bitLen = ciphertext.length * 8;
  const lenBlock = new Uint8Array(16);
  lenBlock[12] = (bitLen >>> 24) & 0xff;
  lenBlock[13] = (bitLen >>> 16) & 0xff;
  lenBlock[14] = (bitLen >>> 8) & 0xff;
  lenBlock[15] = bitLen & 0xff;
  for (let i = 0; i < 16; i++) y[i] = y[i]! ^ lenBlock[i]!;
  return gfMul128(y, h);
}

function incrementCounter(counter: Uint8Array): void {
  for (let i = 15; i >= 12; i--) {
    const next = (counter[i]! + 1) & 0xff;
    counter[i] = next;
    if (next !== 0) break;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0 && i < bytes.length) {
      const b1 = bytes[i++]!;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      const b1 = bytes[i++]!;
      const b2 = bytes[i++]!;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < bytes.length) {
      const b1 = bytes[i++]!;
      const b2 = bytes[i++]!;
      const b3 = bytes[i++]!;
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

export function decryptAes256Gcm(
  key: Uint8Array,
  iv: Uint8Array,
  payloadWithTag: Uint8Array,
): string | null {
  if (key.length !== 32 || iv.length !== 12 || payloadWithTag.length < 16) {
    return null;
  }
  const rk = expandAes256Key(key);
  const cipherLen = payloadWithTag.length - 16;
  const ciphertext = payloadWithTag.subarray(0, cipherLen);
  const expectedTag = payloadWithTag.subarray(cipherLen);

  const j0 = new Uint8Array(16);
  j0.set(iv, 0);
  j0[15] = 1;

  const h = aes256EncryptBlock(new Uint8Array(16), rk);
  const tagMask = aes256EncryptBlock(j0, rk);
  const s = ghash(h, ciphertext);
  let diff = 0;
  for (let i = 0; i < 16; i++) {
    diff |= (tagMask[i]! ^ s[i]!) ^ expectedTag[i]!;
  }
  if (diff !== 0) return null;

  const counter = new Uint8Array(j0);
  const plain = new Uint8Array(cipherLen);
  for (let off = 0; off < cipherLen; off += 16) {
    incrementCounter(counter);
    const ks = aes256EncryptBlock(counter, rk);
    const end = Math.min(off + 16, cipherLen);
    for (let i = off; i < end; i++) {
      plain[i] = ciphertext[i]! ^ ks[i - off]!;
    }
  }
  return decodeUtf8(plain);
}

function decodeBase64UrlBytes(b64u: string): Uint8Array {
  const std = b64u.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  return crypto.base64DecodeBytes(`${std}${pad}`);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function selectKeyParts(parts: string[], version: string | number | undefined): string[] {
  const vNum = Number(version);
  if (Number.isInteger(vNum) && vNum >= 1 && vNum <= 20) {
    const a = vNum;
    const b = 31 - vNum;
    if (a >= 1 && b >= 1 && a <= parts.length && b <= parts.length) {
      const p1 = parts[a - 1];
      const p2 = parts[b - 1];
      if (p1 && p2) return [p1, p2];
    }
  }
  return parts;
}

export function decryptBysePayload(playback: BysePlayback): ByseVideoResponse | null {
  if (!playback.iv || !playback.payload || !Array.isArray(playback.key_parts) || playback.key_parts.length === 0) {
    return null;
  }
  try {
    const chosen = selectKeyParts(playback.key_parts, playback.version);
    const key = concatBytes(chosen.map(decodeBase64UrlBytes));
    const iv = decodeBase64UrlBytes(playback.iv);
    const payload = decodeBase64UrlBytes(playback.payload);
    const plain = decryptAes256Gcm(key, iv, payload);
    if (!plain) return null;
    return JSON.parse(plain) as ByseVideoResponse;
  } catch {
    return null;
  }
}

export async function extractBysezo(
  rawUrl: string,
  opts: ExtractorOpts = {},
): Promise<StreamCandidate[]> {
  const trimmed = rawUrl.trim();
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  let origin = "https://bysezoxexe.com";
  let code = "";

  try {
    const parsed = new URL(normalized);
    origin = parsed.origin;
    const parts = parsed.pathname.split("/").filter(Boolean);
    code = parts[parts.length - 1] ?? "";
  } catch {
    code = /\/([a-zA-Z0-9_-]{8,24})(?:[?#]|$)/.exec(normalized)?.[1] ?? "";
  }
  if (!code) return [];

  if (origin.includes("filemoon.")) {
    origin = "https://bysezoxexe.com";
  }

  let videoData = await fetchJson<ByseVideoResponse>(
    `${origin}/api/videos/${encodeURIComponent(code)}`,
    {
      timeoutMs: 9_000,
      headers: {
        Referer: normalized,
        Accept: "application/json, text/plain, */*",
      },
    },
  );

  if ((!videoData || (!videoData.sources?.length && !videoData.playback)) && origin !== "https://bysezoxexe.com") {
    const details = await fetchJson<ByseDetailsResponse>(
      `${origin}/api/videos/${encodeURIComponent(code)}/details`,
      {
        timeoutMs: 8_000,
        headers: { Referer: normalized },
      },
    );
    const targetUrl = details?.embed_frame_url;
    if (targetUrl) {
      const targetOrigin = new URL(targetUrl).origin;
      videoData = await fetchJson<ByseVideoResponse>(
        `${targetOrigin}/api/videos/${encodeURIComponent(code)}`,
        {
          timeoutMs: 9_000,
          headers: { Referer: targetUrl },
        },
      );
      if (videoData) origin = targetOrigin;
    }
  }
  if (!videoData) return [];

  let sources = videoData.sources ?? [];
  let tracks = videoData.tracks ?? [];
  if (sources.length === 0 && videoData.playback) {
    const decrypted = decryptBysePayload(videoData.playback);
    if (decrypted?.sources?.length) {
      sources = decrypted.sources;
    }
    if (decrypted?.tracks?.length && tracks.length === 0) {
      tracks = decrypted.tracks;
    }
  }
  if (sources.length === 0) return [];

  const streamHeaders = { Referer: `${origin}/` };
  const subtitles: SubtitleTrack[] = [];
  for (const t of tracks) {
    const rawSub = t.file || t.url;
    if (!rawSub) continue;
    const lang = (t.lang ?? "tr").toLowerCase().slice(0, 2) || "tr";
    subtitles.push({
      id: `${lang}_${subtitles.length}`,
      source: { kind: "url", url: rawSub, headers: streamHeaders },
      lang,
      label: t.label ?? (lang === "en" ? "English" : "Türkçe"),
      format: rawSub.includes(".srt") ? "srt" : "vtt",
      isDefault: lang === "tr",
    });
  }

  const prefix = opts.sourceLabel ? `${opts.sourceLabel} • ` : "";
  const audioTag =
    opts.audioType === "dub"
      ? "Dublaj"
      : opts.audioType === "sub"
        ? "Altyazılı"
        : "FileMoon";
  const out: StreamCandidate[] = [];
  for (const src of sources) {
    if (!src.url || !src.url.startsWith("http")) continue;
    const q = src.label || (src.height ? `${src.height}p` : "1080p");
    const kind =
      src.mime_type?.includes("mpegurl") || src.url.includes(".m3u8")
        ? "hls"
        : inferStreamKind(src.url);
    out.push(
      createStream({
        url: src.url,
        kind,
        quality: q,
        label: `${prefix}${audioTag} • ${q} ${kind === "mp4" ? "MP4" : "HLS"}`,
        audioType: opts.audioType,
        language: opts.language ?? (opts.audioType === "dub" ? "tr" : undefined),
        headers: streamHeaders,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
      }),
    );
  }
  return out;
}
