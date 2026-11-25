import { evalWithEnv, html, unpack } from "vessel";
import type { StreamCandidate, SubtitleTrack } from "vessel";
import { DEFAULT_USER_AGENT, MOBILE_USER_AGENT, fetchText, rethrowIfDomainBlocked } from "../core/http.ts";
import { createStream } from "../core/quality.ts";

interface CloseLoadTrack {
  file?: string;
  kind?: string;
  label?: string;
}

function inferTrackLang(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("eng") || l.includes("ing")) return "en";
  if (l.includes("ger") || l.includes("alm")) return "de";
  if (l.includes("fre") || l.includes("fra")) return "fr";
  if (l.includes("spa") || l.includes("isp")) return "es";
  return "tr";
}

async function evaluateCloseLoad(
  scriptBody: string,
  embedUrl: string,
  targetVar: string | null,
): Promise<string | null> {
  let decoded = scriptBody;
  if (/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,/i.test(decoded)) {
    try {
      decoded = unpack(decoded);
    } catch {
      // Fall through to evalWithEnv on raw script if non-standard packer.
    }
  }

  let varName = targetVar;
  if (!varName) {
    const varMatch = /var\s+([a-zA-Z0-9_$]+)\s*=\s*[a-zA-Z0-9_$]+\(\[[^\]]+\]\);/.exec(
      decoded,
    );
    varName = varMatch?.[1] ?? null;
  }
  if (!varName) return null;

  try {
    const res = await evalWithEnv<unknown>(
      `${decoded}\nreturn (typeof ${varName} !== "undefined") ? ${varName} : null;`,
      {
        url: embedUrl,
        userAgent: DEFAULT_USER_AGENT,
      },
    );
    if (typeof res === "string" && res.startsWith("http")) {
      return res;
    }
  } catch (err) {
    rethrowIfDomainBlocked(err);
  }
  return null;
}

export async function extractCloseLoad(
  embedUrlRaw: string,
  pageReferer: string,
  sourceLabel = "HDFilmCehennemi",
): Promise<{ streams: StreamCandidate[]; subtitles: SubtitleTrack[] }> {
  let embedUrl = embedUrlRaw.trim();
  if (embedUrl.startsWith("//")) embedUrl = `https:${embedUrl}`;

  let embedHost = "hdfilmcehennemi.mobi";
  try {
    embedHost = new URL(embedUrl).hostname;
  } catch {
    // Keep default host.
  }

  let streamUrl: string | null = null;
  let lastHtml = "";

  const userAgents = ["Mozilla/5.0", DEFAULT_USER_AGENT, MOBILE_USER_AGENT];
  for (const ua of userAgents) {
    const eHtml = await fetchText(embedUrl, {
      timeoutMs: 10_000,
      headers: {
        "User-Agent": ua,
        Referer: pageReferer,
      },
    });
    if (!eHtml) continue;
    lastHtml = eHtml;

    const varMatch = /sources\s*:\s*\[\s*\{\s*file\s*:\s*([a-zA-Z0-9_$]+)/i.exec(eHtml);
    const targetVar = varMatch?.[1] ?? null;

    const doc = html.parse(eHtml);
    const inlineScripts: string[] = [];
    for (const scriptEl of doc.select("script")) {
      if (scriptEl.attr("src")) continue;
      const typeAttr = scriptEl.attr("type") ?? "";
      if (/application\/ld\+json/i.test(typeAttr)) continue;
      const body = scriptEl.html().trim();
      if (!body || body.includes("__CF$cv$params") || body.includes("jwplayer(")) continue;
      inlineScripts.push(body);

      if (body.includes("var ") && (body.includes("([") || (targetVar && body.includes(targetVar)))) {
        const candidate = await evaluateCloseLoad(body, embedUrl, targetVar);
        if (candidate) {
          streamUrl = candidate;
          break;
        }
      }
    }

    if (!streamUrl && targetVar && inlineScripts.length > 0) {
      streamUrl = await evaluateCloseLoad(inlineScripts.join("\n;\n"), embedUrl, targetVar);
    }

    if (!streamUrl) {
      const ldMatch = /"contentUrl"\s*:\s*"(https?:\/\/[^"]+)"/i.exec(eHtml);
      if (ldMatch?.[1]) streamUrl = ldMatch[1];
    }

    if (streamUrl) break;
  }

  if (!streamUrl) return { streams: [], subtitles: [] };

  const embedHeaders = {
    "User-Agent": DEFAULT_USER_AGENT,
    Referer: `https://${embedHost}/`,
  };

  const subtitles: SubtitleTrack[] = [];
  const tracksMatch = /tracks\s*:\s*(\[[^\]]+\])/i.exec(lastHtml);
  if (tracksMatch?.[1]) {
    try {
      const rawTracks = JSON.parse(tracksMatch[1]) as CloseLoadTrack[];
      for (let i = 0; i < rawTracks.length; i++) {
        const track = rawTracks[i];
        if (!track?.file || track.kind !== "captions") continue;
        const label = track.label ?? "Altyazı";
        const lang = inferTrackLang(label);
        subtitles.push({
          id: `closeload_${i}`,
          source: {
            kind: "url",
            url: track.file,
            headers: embedHeaders,
          },
          lang,
          label,
          format: "vtt",
          isDefault: lang === "tr",
        });
      }
    } catch {
      // Ignore malformed track blocks.
    }
  }

  const stream = createStream({
    url: streamUrl,
    kind: "hls",
    quality: "1080p",
    label: `${sourceLabel} • CloseLoad • 1080p Dual HLS`,
    audioType: "dub",
    language: "tr",
    flags: ["multi_audio", "subtitled"],
    headers: embedHeaders,
    subtitles,
  });

  return { streams: [stream], subtitles };
}
