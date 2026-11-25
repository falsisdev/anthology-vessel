import { definePlugin, html, unpack } from "vessel";
import type {
  Episode,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  SeasonSummary,
  StreamCandidate,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchText,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import {
  dedupeMediaSummaries,
  finalizeStreams,
  pickBestCandidate,
} from "./shared/core/plugin-helpers.ts";
import { createStream } from "./shared/core/quality.ts";
import {
  absoluteUrl,
  decodeHtmlEntities,
  parseSeasonEpisode,
  slugify,
} from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";

const DEFAULT_BASE = "https://dizipod.com";
const PLAYER_URL = "https://player.dizipod.com";

function parsePodCards(rawHtml: string, base: string): MediaSummary[] {
  const doc = html.parse(rawHtml);
  const out: MediaSummary[] = [];
  const seen = new Set<string>();

  for (const a of doc.select('a[href*="/diziler/"], a[href*="/film/"]')) {
    const href = a.attr("href");
    if (!href) continue;
    const full = absoluteUrl(base, href);
    if (/\/(?:diziler|film|filmler|dizi)\/?$/i.test(full)) continue;
    if (seen.has(full)) continue;
    const img = a.selectOne("img");
    const rawTitle =
      a.selectOne(".title, h2, h3")?.text() || img?.attr("alt") || a.text();
    const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
    if (!title || title.length < 2) continue;
    seen.add(full);
    const kind: "movie" | "series" = full.includes("/film/") ? "movie" : "series";
    const poster = img?.attr("data-src") || img?.attr("src");
    out.push({
      nativeId: `${kind}:${encodeURIComponent(full)}`,
      type: kind,
      title,
      poster: poster ? absoluteUrl(base, poster) : undefined,
    });
  }
  return out;
}

async function resolvePodPostStream(
  pageUrl: string,
  base: string,
): Promise<StreamCandidate[]> {
  const pageHtml = await fetchText(pageUrl, {
    timeoutMs: 10_000,
    headers: buildHeaders(`${base}/`),
  });
  const postId = pageHtml ? /data-post-id="(\d+)"/.exec(pageHtml)?.[1] : null;
  if (!postId) return [];

  const ajaxText = await fetchText(
    `${base}/wp/wp-admin/admin-ajax.php?action=get_episode_player&post_id=${encodeURIComponent(postId)}`,
    {
      timeoutMs: 8_000,
      headers: {
        ...buildHeaders(pageUrl),
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!ajaxText) return [];

  let embedHtml = "";
  try {
    const j = JSON.parse(ajaxText) as { success?: boolean; data?: string };
    if (!j.success || !j.data) return [];
    embedHtml = j.data;
  } catch {
    return [];
  }

  const ifrMatch = /src=\\?"([^"\\]+)"/i.exec(embedHtml);
  if (!ifrMatch?.[1]) return [];
  const rawEmbed = ifrMatch[1].replace(/\\/g, "");
  const embedUrl = rawEmbed.startsWith("http") ? rawEmbed : `${PLAYER_URL}${rawEmbed}`;

  const embHtml = await fetchText(embedUrl, {
    timeoutMs: 8_000,
    headers: buildHeaders(`${base}/`),
  });
  if (!embHtml) return [];

  const unpacked = embHtml.includes("eval(function(p,a,c,k,e,") ? unpack(embHtml) : embHtml;
  const searchPool = `${unpacked}\n${embHtml}`;
  const out: StreamCandidate[] = [];
  const seen = new Set<string>();

  const srcArrMatch = /sources:\s*(\[\{.+?\}\])/.exec(unpacked);
  if (srcArrMatch?.[1]) {
    try {
      const cleanJson = srcArrMatch[1].replace(
        /([{,]\s*)([a-zA-Z0-9_]+)\s*:/g,
        '$1"$2":',
      );
      const parsed = JSON.parse(cleanJson) as Array<{ file?: string; label?: string }>;
      for (const s of parsed) {
        const u = s.file?.replace(/\\/g, "") ?? "";
        if (!u || !u.includes(".m3u8") || seen.has(u)) continue;
        seen.add(u);
        const q = s.label || "1080p";
        out.push(
          createStream({
            url: u,
            kind: "hls",
            quality: q,
            label: `DiziPod • Türkçe Altyazılı [${q}]`,
            headers: buildHeaders(`${PLAYER_URL}/`),
          }),
        );
      }
    } catch {
      // Fall through to regex fallback
    }
  }

  if (out.length === 0) {
    const directRe = /https?:\\?\/\\?\/[a-zA-Z0-9.-]+\.tyuopix\.com[^\s"']+\.m3u8/g;
    let m: RegExpExecArray | null;
    while ((m = directRe.exec(searchPool)) !== null) {
      const u = m[0].replace(/\\\//g, "/").replace(/\\/g, "");
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(
        createStream({
          url: u,
          kind: "hls",
          quality: "1080p",
          label: "DiziPod • Türkçe Altyazılı [1080p]",
          headers: buildHeaders(`${PLAYER_URL}/`),
        }),
      );
    }
  }

  return out;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const base = await resolveBaseUrl("urls.series.dizipod.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      const all = rawHtml ? parsePodCards(rawHtml, base) : [];
      const series = dedupeMediaSummaries(all.filter((x) => x.type === "series")).slice(0, 30);
      const movies = dedupeMediaSummaries(all.filter((x) => x.type === "movie")).slice(0, 30);
      const sections: HomeFeed["sections"] = [
        { id: "series", title: "Popüler Diziler", layout: "poster" as const, items: series },
        { id: "movies", title: "Popüler Filmler", layout: "poster" as const, items: movies },
      ].filter((s) => s.items.length > 0);
      return { sections };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(query, _filters, page): Promise<SearchPage> {
    try {
      if (page > 1 || !query.trim()) return { items: [], hasMore: false };
      const base = await resolveBaseUrl("urls.series.dizipod.base", DEFAULT_BASE, "mirrorUrl");
      const rawHtml = await fetchText(`${base}/?s=${encodeURIComponent(query.trim())}`, {
        timeoutMs: 10_000,
        headers: buildHeaders(`${base}/`),
      });
      return {
        items: rawHtml ? dedupeMediaSummaries(parsePodCards(rawHtml, base)).slice(0, 30) : [],
        hasMore: false,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    const base = await resolveBaseUrl("urls.series.dizipod.base", DEFAULT_BASE, "mirrorUrl");
    const pageUrl = decodeURIComponent(nativeId.replace(/^(?:movie|series):/, ""));
    const rawHtml = await fetchText(pageUrl, {
      timeoutMs: 10_000,
      headers: buildHeaders(`${base}/`),
    });
    if (!rawHtml) throw new Error(`DiziPod içerik açılamadı: ${pageUrl}`);

    const doc = html.parse(rawHtml);
    const title = decodeHtmlEntities(doc.selectOne("h1")?.text() || "DiziPod").trim();
    const poster = doc.selectOne('meta[property="og:image"]')?.attr("content") ?? undefined;
    if (pageUrl.includes("/film/")) {
      return {
        nativeId,
        type: "movie",
        title,
        poster,
        backdrop: poster,
        episodes: [{ streamId: `page:${encodeURIComponent(pageUrl)}`, season: 1, episode: 1, title }],
      };
    }

    const episodes: Episode[] = [];
    const seen = new Set<string>();
    for (const a of doc.select('a[href*="-sezon-"][href*="-bolum"]')) {
      const href = a.attr("href");
      if (!href) continue;
      const full = absoluteUrl(base, href);
      if (seen.has(full)) continue;
      seen.add(full);
      const parsed = parseSeasonEpisode(full, 1);
      const s = parsed?.season ?? 1;
      const e = parsed?.episode ?? episodes.length + 1;
      episodes.push({
        streamId: `page:${encodeURIComponent(full)}`,
        season: s,
        episode: e,
        title: `${s}. Sezon ${e}. Bölüm`,
      });
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const seasons: SeasonSummary[] = Array.from(new Set(episodes.map((e) => e.season))).map(
      (s) => ({
        id: String(s),
        season: s,
        title: `${s}. Sezon`,
        episodeCount: episodes.filter((e) => e.season === s).length,
      }),
    );

    return { nativeId, type: "series", title, poster, backdrop: poster, seasons, episodes };
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl("urls.series.dizipod.base", DEFAULT_BASE, "mirrorUrl");
      if (streamId.startsWith("page:")) {
        return finalizeStreams(await resolvePodPostStream(decodeURIComponent(streamId.slice(5)), base));
      }

      const parts = streamId.split(":");
      const typeHint: "movie" | "series" = parts[2] ? "series" : "movie";
      const identity = await resolveTmdbIdentity(parts[0] ?? streamId, typeHint);
      if (!identity) return { streams: [] };
      const sTarget = Number.parseInt(parts[1] ?? "1", 10) || 1;
      const eTarget = Number.parseInt(parts[2] ?? "1", 10) || 1;

      for (const title of [identity.originalTitle, identity.title].filter(Boolean)) {
        const slug = slugify(title);
        if (!slug) continue;
        const candUrl =
          typeHint === "series"
            ? `${base}/${slug}-${sTarget}-sezon-${eTarget}-bolum/`
            : `${base}/film/${slug}/`;
        const streams = await resolvePodPostStream(candUrl, base);
        if (streams.length > 0) return finalizeStreams(streams);
      }

      const sr = await this.search!(identity.title, {}, 1);
      const filtered = sr.items.filter((x) => x.type === typeHint);
      const best = pickBestCandidate(
        (filtered.length > 0 ? filtered : sr.items).map((x) => ({
          title: x.title,
          nativeId: x.nativeId,
        })),
        identity.title,
        identity.originalTitle,
      );
      if (!best) return { streams: [] };
      const detail = await this.getDetails!(best.nativeId);
      const ep =
        typeHint === "movie"
          ? detail.episodes[0]
          : detail.episodes.find((x) => x.season === sTarget && x.episode === eTarget);
      if (!ep) return { streams: [] };
      return finalizeStreams(await resolvePodPostStream(decodeURIComponent(ep.streamId.slice(5)), base));
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
