import { definePlugin, html } from "vessel";
import type {
  AudioType,
  HomeFeed,
  MediaDetail,
  MediaSummary,
  SearchPage,
  StreamCandidate,
} from "vessel";
import { resolveBaseUrl } from "./shared/core/config.ts";
import {
  buildHeaders,
  fetchJson,
  fetchText,
  postForm,
  rethrowIfDomainBlocked,
} from "./shared/core/http.ts";
import {
  getTmdbBackedMovieDetails,
  getTmdbMovieHomeSections,
  searchTmdbBackedCatalog,
} from "./shared/core/plugin-helpers.ts";
import { sortStreamsByQuality } from "./shared/core/quality.ts";
import { slugify } from "./shared/core/text.ts";
import { resolveTmdbIdentity } from "./shared/core/tmdb.ts";
import { extractByEmbedUrl } from "./shared/extractors/video-hosts.ts";

const DEFAULT_BASE = "https://webteizle.info";

interface AlternatifItem {
  id: string;
  baslik?: string;
  kalite?: string;
}

interface SearchApiResponse {
  status?: string;
  results?: {
    filmler?: {
      results?: Array<{ url?: string; title?: string }>;
    };
  };
}

async function findFilmPage(
  base: string,
  titleTr: string,
  titleEn: string,
): Promise<{ url: string; body: string } | null> {
  const candidates: string[] = [];
  const slugTr = slugify(titleTr);
  const slugEn = slugify(titleEn);

  if (slugTr) {
    candidates.push(`${base}/izle/dublaj/${slugTr}`, `${base}/izle/altyazi/${slugTr}`);
  }
  if (slugEn && slugEn !== slugTr) {
    candidates.push(`${base}/izle/dublaj/${slugEn}`, `${base}/izle/altyazi/${slugEn}`);
  }

  const candidateResults = await Promise.all(
    candidates.map(async (url) => ({
      url,
      body: await fetchText(url, {
        timeoutMs: 6_000,
        headers: buildHeaders(`${base}/`),
      }),
    })),
  );
  for (const cand of candidateResults) {
    if (cand.body && cand.body.includes("data-id") && cand.body.includes('id="wip"')) {
      return { url: cand.url, body: cand.body };
    }
  }

  for (const query of [titleTr, titleEn].filter(Boolean)) {
    const res = await postForm(
      `${base}/ajax/arama.asp`,
      { q: query },
      {
        timeoutMs: 8_000,
        headers: {
          Referer: `${base}/`,
          "X-Requested-With": "XMLHttpRequest",
        },
      },
    );
    if (!res || res.status < 200 || res.status >= 300) continue;
    try {
      const data = res.json<SearchApiResponse>();
      const first = data.results?.filmler?.results?.[0];
      if (first?.url) {
        const pageUrl = first.url.startsWith("http")
          ? first.url
          : `${base}${first.url.startsWith("/") ? "" : "/"}${first.url}`;
        const body = await fetchText(pageUrl, {
          timeoutMs: 8_000,
          headers: buildHeaders(`${base}/`),
        });
        if (body) return { url: pageUrl, body };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveEmbedToken(embedHtml: string): string | null {
  const doc = html.parse(embedHtml);
  const iframeSrc = doc.selectOne("iframe[src]")?.attr("src");
  if (iframeSrc) return iframeSrc;

  const short = /(vidmoly|okru|sibnet)\s*\(\s*'([^']+)'/i.exec(embedHtml);
  if (!short?.[1] || !short[2]) return null;
  const host = short[1].toLowerCase();
  const vid = short[2];
  if (host === "vidmoly") return `https://vidmoly.biz/embed-${vid}.html`;
  if (host === "okru") return `https://odnoklassniki.ru/videoembed/${vid}`;
  if (host === "sibnet") return `https://video.sibnet.ru/shell.php?videoid=${vid}`;
  return null;
}

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const { popularMovies, topMovies } = await getTmdbMovieHomeSections({
        idPrefix: "webteizle",
      });
      const sections: HomeFeed["sections"] = [
        { id: "popular", title: "Popüler Filmler", layout: "poster" as const, items: popularMovies },
        { id: "top", title: "Yüksek Puanlı Filmler", layout: "poster" as const, items: topMovies },
      ].filter((s) => s.items.length > 0);
      return { sections };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(query, _filters, page): Promise<SearchPage> {
    try {
      return await searchTmdbBackedCatalog({
        idPrefix: "webteizle",
        query,
        mediaType: "movie",
        page,
      });
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId): Promise<MediaDetail> {
    return getTmdbBackedMovieDetails({
      nativeId,
      idPrefix: "webteizle",
      mediaType: "movie",
    });
  },

  async getStreams(streamId) {
    try {
      const base = await resolveBaseUrl(
        "urls.movies.webteizle.base",
        DEFAULT_BASE,
        "mirrorUrl",
      );
      const parts = streamId.split(":");
      const rawId = parts.length >= 3 ? parts[2]! : parts[0]!;
      const identity = await resolveTmdbIdentity(rawId, "movie");
      if (!identity) return { streams: [] };

      const page = await findFilmPage(base, identity.title, identity.originalTitle);
      if (!page) return { streams: [] };

      const doc = html.parse(page.body);
      const filmId =
        doc.selectOne("#wip[data-id]")?.attr("data-id") ??
        doc.selectOne("[data-id]")?.attr("data-id") ??
        /data-id="(\d+)"/.exec(page.body)?.[1];
      if (!filmId) return { streams: [] };

      const diller: Array<{ dil: string; audioType: AudioType }> = [];
      if (page.body.includes("/izle/dublaj/") || page.url.includes("/izle/dublaj/")) {
        diller.push({ dil: "0", audioType: "dub" });
      }
      if (page.body.includes("/izle/altyazi/") || page.url.includes("/izle/altyazi/")) {
        diller.push({ dil: "1", audioType: "sub" });
      }
      if (diller.length === 0) {
        diller.push({ dil: "0", audioType: "dub" }, { dil: "1", audioType: "sub" });
      }

      const langResults = await Promise.all(
        diller.map(async (d) => {
          const altRes = await postForm(
            `${base}/ajax/dataAlternatif3.asp`,
            { filmid: filmId, dil: d.dil, s: "", b: "", bot: "0" },
            {
              timeoutMs: 6_000,
              headers: {
                Referer: page.url,
                Origin: base,
                "X-Requested-With": "XMLHttpRequest",
              },
            },
          );
          if (!altRes || altRes.status < 200 || altRes.status >= 300) return [];

          let list: AlternatifItem[] = [];
          try {
            const j = altRes.json<{ status?: string; data?: AlternatifItem[] }>();
            if (j.status === "success" && Array.isArray(j.data)) list = j.data;
          } catch {
            return [];
          }

          const filtered = list.filter((item) => {
            const nameLower = (item.baslik ?? "").toLowerCase();
            return nameLower !== "pixel" && nameLower !== "netu";
          });

          const nested = await Promise.all(
            filtered.slice(0, 6).map(async (item) => {
              const embRes = await postForm(
                `${base}/ajax/dataEmbed.asp`,
                { id: String(item.id) },
                {
                  timeoutMs: 6_000,
                  headers: {
                    Referer: page.url,
                    Origin: base,
                    "X-Requested-With": "XMLHttpRequest",
                  },
                },
              );
              if (!embRes || embRes.status < 200 || embRes.status >= 300) return [];
              const embedSrc = resolveEmbedToken(embRes.text());
              if (!embedSrc) return [];
              return extractByEmbedUrl(embedSrc, {
                sourceLabel: "Webteİzle",
                audioType: d.audioType,
                referer: `${base}/`,
              });
            }),
          );
          return nested.flat();
        }),
      );
      const streams = langResults.flat();

      return { streams: sortStreamsByQuality(streams) };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
