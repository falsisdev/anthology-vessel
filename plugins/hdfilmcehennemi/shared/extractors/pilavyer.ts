import type { StreamCandidate, SubtitleTrack } from "vessel";
import { DEFAULT_USER_AGENT, fetchText } from "../core/http.ts";
import { createStream } from "../core/quality.ts";

interface PilavyerAudio {
  label?: string;
  name?: string;
}

interface PilavyerSub {
  sid?: string;
  src?: string;
  lang?: string;
  label?: string;
}

interface PilavyerPayload {
  stream?: string;
  audios?: PilavyerAudio[];
  subs?: PilavyerSub[];
}

export async function extractPilavyer(opts: {
  pvId?: string;
  playerUrl?: string;
  playerHost?: string;
  referer: string;
  sourceLabel: string;
}): Promise<{ streams: StreamCandidate[]; subtitles: SubtitleTrack[] }> {
  const host = (opts.playerHost ?? "https://play2.pilavyerplay.top").replace(/\/+$/, "");
  let targetScriptUrl = "";

  if (opts.pvId) {
    targetScriptUrl = `${host}/assets/js/s.php?s=${encodeURIComponent(opts.pvId)}`;
  } else if (opts.playerUrl) {
    let url = opts.playerUrl.trim();
    if (url.startsWith("//")) url = `https:${url}`;
    const embedHtml = await fetchText(url, {
      timeoutMs: 10_000,
      headers: { Referer: opts.referer },
    });
    if (!embedHtml) return { streams: [], subtitles: [] };

    const scriptMatch =
      /src=["']([^"']*assets\/js\/s\.php\?[^"']+)["']/i.exec(embedHtml) ??
      /\?s=([a-zA-Z0-9_-]+)/.exec(url);
    if (scriptMatch && scriptMatch[1]) {
      const val = scriptMatch[1];
      targetScriptUrl = val.startsWith("http")
        ? val
        : val.includes("s.php")
          ? `${new URL(url).origin}${val.startsWith("/") ? "" : "/"}${val}`
          : `${new URL(url).origin}/assets/js/s.php?s=${encodeURIComponent(val)}`;
    }
  }

  if (!targetScriptUrl) return { streams: [], subtitles: [] };

  const scriptOrigin = new URL(targetScriptUrl).origin;
  const jsText = await fetchText(targetScriptUrl, {
    timeoutMs: 10_000,
    headers: { Referer: opts.referer },
  });
  if (!jsText) return { streams: [], subtitles: [] };

  const jsonMatch = /window\.__PLAYER__\s*=\s*(\{[\s\S]*?\});/.exec(jsText);
  if (!jsonMatch || !jsonMatch[1]) return { streams: [], subtitles: [] };

  let payload: PilavyerPayload;
  try {
    payload = JSON.parse(jsonMatch[1]) as PilavyerPayload;
  } catch {
    return { streams: [], subtitles: [] };
  }
  if (!payload.stream) return { streams: [], subtitles: [] };

  const streamHeaders = {
    Referer: `${scriptOrigin}/`,
    "User-Agent": DEFAULT_USER_AGENT,
  };

  const subtitles: SubtitleTrack[] = [];
  for (const sub of payload.subs ?? []) {
    if (!sub.src) continue;
    const langLower = (sub.lang ?? "").toLowerCase();
    const isTr = langLower === "tr" || /t[üu]rk[çc]e|tur/i.test(sub.label ?? "");
    const subUrl = sub.src.startsWith("http")
      ? sub.src
      : `${scriptOrigin}${sub.src.startsWith("/") ? "" : "/"}${sub.src}`;
    subtitles.push({
      id: sub.sid ?? (isTr ? "tr" : "en"),
      source: {
        kind: "url",
        url: subUrl,
        headers: streamHeaders,
      },
      lang: isTr ? "tr" : langLower || "en",
      label: sub.label || (isTr ? "Türkçe" : "English"),
      format: "vtt",
      isDefault: isTr,
    });
  }

  // Keep CDN nodes & append &ext=.m3u8 (never use cdn=0 to avoid ExoPlayer black-screen issue).
  const cleanStreamUrl = payload.stream
    .replace(/[?&]cdn=\d+/i, "")
    .replace(/#.*$/, "");
  const finalStreamUrl =
    cleanStreamUrl + (cleanStreamUrl.includes("?") ? "&" : "?") + "ext=.m3u8";

  const audios =
    Array.isArray(payload.audios) && payload.audios.length > 0
      ? payload.audios
      : [{ label: "Orijinal" }];

  let audioTag = "Orijinal (TR Altyazılı)";
  let audioType: "sub" | "dub" | "original" = "sub";
  const flags: Array<"multi_audio" | "dubbed" | "subtitled"> = [];

  if (audios.length > 1) {
    const hasTr = audios.some((a) =>
      /t[üu]rk[çc]e|turkce|\btr\b/i.test(a.label ?? a.name ?? ""),
    );
    audioTag = hasTr ? "Çift Ses (TR Dublaj & Orijinal)" : "Çoklu Ses";
    audioType = "dub";
    flags.push("multi_audio");
  } else {
    const raw = (audios[0]?.label ?? audios[0]?.name ?? "Orijinal").trim();
    if (/t[üu]rk[çc]e|turkce|\btr\b/i.test(raw)) {
      audioTag = "Türkçe Dublaj";
      audioType = "dub";
    } else if (/japonca|japanese|\bja\b/i.test(raw)) {
      audioTag = "Japonca (Orijinal)";
      audioType = "sub";
    } else if (/ingilizce|english|\ben\b/i.test(raw)) {
      audioTag = "İngilizce (Orijinal)";
      audioType = "sub";
    }
  }

  const stream = createStream({
    url: finalStreamUrl,
    kind: "hls",
    quality: "1080p",
    label: `${opts.sourceLabel} • ${audioTag} • 1080p FHD`,
    audioType,
    language: audioType === "dub" ? "tr" : undefined,
    flags,
    headers: streamHeaders,
    subtitles,
  });

  return { streams: [stream], subtitles };
}
