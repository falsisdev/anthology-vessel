import { crypto, html } from "vessel";
import type { MediaSummary, StreamCandidate } from "vessel";
import { configString } from "../config.ts";
import { buildHeaders, fetchText, postForm } from "../http.ts";
import { pickBestCandidate } from "../plugin-helpers.ts";
import { createStream } from "../quality.ts";
import { absoluteUrl, decodeHtmlEntities, dedupeStrings, extractYear, slugify } from "../text.ts";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";
import { extractVixolity } from "../../extractors/vixolity.ts";

export function parseSinemacxCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const items: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const el of doc.select("a[href*='/film/'], article a[href]")) {
    const href = el.attr("href");
    if (!href || !href.includes("/film/")) continue;
    const url = absoluteUrl(base, href);
    if (seen.has(url)) continue;

    const img = el.selectOne("img");
    const rawTitle = el.attr("title") || img?.attr("alt") || el.text().trim();
    const title = decodeHtmlEntities(rawTitle).replace(/\s*izle\s*$/i, "").trim();
    if (!title || title.length < 2) continue;
    seen.add(url);

    const poster = img?.attr("data-src") || img?.attr("src");
    items.push({
      nativeId: `movie:${encodeURIComponent(url)}`,
      type: "movie",
      title,
      year: extractYear(title),
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return items;
}

export async function resolveSinemaCxPage(
  pageUrl: string,
  base: string,
  expectedImdbId?: string,
): Promise<StreamCandidate[]> {
  const pageHtml = await fetchText(pageUrl, {
    timeoutMs: 8_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!pageHtml) return [];

  const doc = html.parse(pageHtml);
  if (expectedImdbId) {
    const imdbHref = doc.selectOne('a[href*="imdb.com/title/tt"]')?.attr("href");
    const pageImdb = /tt\d+/.exec(imdbHref ?? "")?.[0];
    if (pageImdb && pageImdb !== expectedImdbId) {
      return [];
    }
  }

  const bodyLower = doc.selectOne("body")?.text().toLowerCase() ?? "";
  const audioType = bodyLower.includes("dublaj")
    ? "dub"
    : bodyLower.includes("altyaz")
      ? "sub"
      : undefined;

  let iframeUrl = "";
  for (const ifr of doc.select("iframe")) {
    let src = ifr.attr("data-vsrc") || ifr.attr("src") || "";
    if (!src) continue;
    if (!/^https?:\/\//i.test(src) && !src.startsWith("//")) {
      try {
        src = crypto.base64Decode(src);
      } catch {
        continue;
      }
    }
    if (src.toLowerCase().includes("filmizle.in")) {
      iframeUrl = absoluteUrl(base, src).split("?")[0] ?? "";
      break;
    }
  }
  if (!iframeUrl) return [];

  const videoId = iframeUrl.split("/").pop()?.split("?")[0] ?? "";
  if (!videoId) return [];
  const res = await postForm(
    `https://player.filmizle.in/player/index.php?data=${encodeURIComponent(videoId)}&do=getVideo`,
    { hash: videoId, r: pageUrl },
    {
      timeoutMs: 6_000,
      headers: {
        Referer: iframeUrl.toLowerCase(),
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!res || res.status < 200 || res.status >= 300) return [];

  try {
    const json = res.json<{ securedLink?: string }>();
    if (!json.securedLink) return [];
    return [
      createStream({
        url: json.securedLink,
        kind: "hls",
        quality: "1080p",
        label:
          audioType === "dub"
            ? "SinemaCX • Türkçe Dublaj 1080p HLS"
            : audioType === "sub"
              ? "SinemaCX • Türkçe Altyazılı 1080p HLS"
              : "SinemaCX • 1080p HLS",
        audioType,
        language: audioType === "dub" ? "tr" : undefined,
        headers: buildHeaders("https://player.filmizle.in/"),
      }),
    ];
  } catch {
    return [];
  }
}

export async function resolveSinemaCxByIdentity(opts: {
  identity: ResolvedTmdbIdentity;
  base?: string;
  exactImdbIfPresent?: boolean;
  includeVixolity?: boolean;
}): Promise<StreamCandidate[]> {
  const { identity } = opts;
  if (identity.mediaType !== "movie") return [];

  const base = (
    opts.base ??
    (await configString("urls.movies.sinemacx.base", "https://sinemacc.com"))
  ).replace(/\/+$/, "");

  let targetUrl = "";
  for (const q of dedupeStrings([identity.originalTitle, identity.title]).slice(0, 2)) {
    const sHtml = await fetchText(
      `${base}/?s=${encodeURIComponent(q)}`,
      { timeoutMs: 8_000, headers: buildHeaders(`${base}/`) },
    );
    if (!sHtml) continue;
    const cards = parseSinemacxCards(sHtml, base).map((c) => ({
      title: c.title,
      year: c.year,
      url: decodeURIComponent(c.nativeId.replace(/^movie:/, "")),
    }));
    const best = pickBestCandidate(
      cards,
      identity.title,
      identity.originalTitle,
      identity.year,
    );
    if (best) {
      targetUrl = best.url;
      break;
    }
  }

  if (!targetUrl && !opts.exactImdbIfPresent) {
    const fallbackSlug = slugify(identity.originalTitle || identity.title);
    if (fallbackSlug) targetUrl = `${base}/film/${fallbackSlug}/`;
  }

  const streams: StreamCandidate[] = targetUrl
    ? await resolveSinemaCxPage(
        targetUrl,
        base,
        opts.exactImdbIfPresent ? identity.imdbId : undefined,
      )
    : [];

  if (streams.length === 0 && opts.includeVixolity && identity.imdbId) {
    const vix = await extractVixolity({
      imdbId: identity.imdbId,
      sourceLabel: "SinemaCX",
    });
    streams.push(...vix.streams);
  }

  return streams;
}
