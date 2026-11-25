import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import type { PluginManifest } from "vessel";
import { installVesselMockHooks, setActivePluginContext } from "./vessel-mock.ts";

installVesselMockHooks();

const { http, html, crypto, storage, unpack, evalWithEnv } = await import("vessel");
const { clearConfigCache, configString, readToggleSetting } = await import("../core/config.ts");
const { SEICODE_TMDB_MAP } = await import("../core/exact-tmdb-sources.ts");
const { tmdbSearch, tmdbBuildMediaDetail } = await import("../core/tmdb.ts");
const { ultraClean, titleSimilarity, parseSeasonEpisode, slugify } = await import(
  "../core/text.ts"
);
const { createStream, sortStreamsByQuality } = await import("../core/quality.ts");
const { channelLangLabel } = await import("../core/epg.ts");
const { isDomainBlockedError } = await import("../core/http.ts");
const { parseVixolitySubtitles } = await import("../extractors/vixolity.ts");
const { decryptAes256Gcm, decryptBysePayload } = await import("../extractors/bysezo.ts");

async function runTests(): Promise<void> {
  // 1. Domain policy gate check
  setActivePluginContext({
    schemaVersion: 1,
    id: "test-plugin",
    name: "Test",
    version: "1.0.0",
    entry: "index.ts",
    capabilities: ["vod"],
    domains: ["example.com", "*.trusted.org"],
  });

  await assert.rejects(
    () => http.get("https://evil.invalid/test"),
    (err: unknown) => isDomainBlockedError(err),
  );

  // 2. Text normalization and similarity
  assert.equal(ultraClean("G.O.R.A. - AŞK & Rüzgâr!"), "goraaskruzgar");
  assert.equal(slugify("Kurtlar Vadisi: Pusu"), "kurtlar-vadisi-pusu");
  assert.equal(titleSimilarity("The Matrix", "The Matrix"), 1);
  assert.ok(titleSimilarity("The Matrix", "Matrix") >= 0.5);
  assert.deepEqual(parseSeasonEpisode("Breaking Bad 3. Sezon 7. Bölüm"), {
    season: 3,
    episode: 7,
  });

  // 3. Quality sorting prefers MP4 ties and sets default on first non-embed stream
  const sorted = sortStreamsByQuality([
    createStream({ url: "https://cdn.test/embed", kind: "embed", label: "Embed", quality: "1080p" }),
    createStream({ url: "https://cdn.test/720.m3u8", kind: "hls", label: "HLS", quality: "720p" }),
    createStream({ url: "https://cdn.test/1080.mp4", kind: "mp4", label: "MP4", quality: "1080p" }),
    createStream({ url: "https://cdn.test/1080.m3u8", kind: "hls", label: "HLS", quality: "1080p" }),
  ]);
  assert.equal(sorted[0]?.kind, "mp4");
  assert.equal(sorted[0]?.isDefault, true);
  assert.equal(sorted[1]?.quality, "1080p");
  assert.equal(sorted.every((s) => (s.kind === "embed" ? !s.isDefault : true)), true);

  // 4. HTML parser CSS selectors
  const doc = html.parse(
    '<div id="list"><article class="card"><a href="/film/1" data-id="99"> Matrix </a></article></div>',
  );
  const link = doc.selectOne("#list .card > a[data-id='99']");
  assert.ok(link);
  assert.equal(link.text(), "Matrix");
  assert.equal(link.attr("href"), "/film/1");

  // 5. Crypto & EPG roundtrip
  const enc = crypto.aesEncrypt(
    "anthology-vessel",
    "1234567890123456",
    "6543210987654321",
    "cbc",
  );
  assert.equal(
    crypto.aesDecrypt(enc, "1234567890123456", "6543210987654321", "cbc"),
    "anthology-vessel",
  );
  assert.equal(channelLangLabel("tr"), "Türkçe");

  // 6. Vixolity subtitle parsing & unpacker
  const subs = parseVixolitySubtitles(
    '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Türkçe",LANGUAGE="tur",URI="https://ha.vixolity.com/tr.vtt"',
  );
  assert.equal(subs.length, 1);
  assert.equal(subs[0]?.lang, "tur");

  const unpacked = unpack(
    "eval(function(p,a,c,k,e,d){return p}('0 1=\"2\";',3,3,'var|x|ok'.split('|'),0,{}))",
  );
  assert.equal(unpacked, 'var x="ok";');

  // 7. evalWithEnv sandbox
  const val = await evalWithEnv<string>(
    'var host = location.hostname; var ua = navigator.userAgent; return host + "|" + ua.slice(0, 7);',
    { url: "https://closeload.com/embed/abc", userAgent: "VesselBot/1.0" },
  );
  assert.equal(val, "closeload.com|VesselB");

  // 8. Toggle settings & exact TMDB map
  setActivePluginContext(
    {
      schemaVersion: 1,
      id: "toggle-test",
      name: "Toggle Test",
      version: "1.0.0",
      entry: "index.ts",
      capabilities: ["vod"],
      domains: ["example.com"],
      settingsSchema: [
        { key: "enableA", label: "A", type: "toggle", default: true },
        { key: "enableB", label: "B", type: "toggle", default: false },
      ],
    },
    { enableC: "false", enableD: "1" },
  );
  assert.equal(await readToggleSetting("enableA", true), true);
  assert.equal(await readToggleSetting("enableB", true), false);
  assert.equal(await readToggleSetting("enableC", true), false);
  assert.equal(await readToggleSetting("enableD", false), true);
  assert.equal(await readToggleSetting("enableUnset", true), true);
  assert.equal(SEICODE_TMDB_MAP["127532"], "solo-leveling");

  // 9. Persistent storage config cache avoids remote HTTP fetch when fresh
  clearConfigCache();
  await storage.set("__anthology_remote_cfg_v1", {
    at: Date.now(),
    data: { urls: { movies: { sinemacx: { base: "https://cached.example" } } } },
  });
  assert.equal(
    await configString("urls.movies.sinemacx.base", "https://fallback.example"),
    "https://cached.example",
  );
  clearConfigCache();

  // 10. Pure-TS AES-256-GCM & Bysezo FileMoon payload decryption
  const gcmKey = nodeCrypto.randomBytes(32);
  const gcmIv = nodeCrypto.randomBytes(12);
  const sampleJson = JSON.stringify({
    sources: [{ label: "1080p", url: "https://cdn.byse.test/hls2/master.m3u8" }],
  });
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", gcmKey, gcmIv);
  const encrypted = Buffer.concat([cipher.update(sampleJson, "utf8"), cipher.final(), cipher.getAuthTag()]);
  assert.equal(decryptAes256Gcm(gcmKey, gcmIv, encrypted), sampleJson);
  const keyParts = Array.from({ length: 30 }, () => nodeCrypto.randomBytes(16).toString("base64url"));
  keyParts[4] = gcmKey.subarray(0, 16).toString("base64url");
  keyParts[25] = gcmKey.subarray(16, 32).toString("base64url");
  const decodedPayload = decryptBysePayload({
    algorithm: "AES-256-GCM",
    iv: gcmIv.toString("base64url"),
    payload: encrypted.toString("base64url"),
    key_parts: keyParts,
    version: "5",
  });
  assert.equal(decodedPayload?.sources?.[0]?.url, "https://cdn.byse.test/hls2/master.m3u8");

  // 11. Mocked HTTP regression suite for TMDB anime filter, multi-season detail, YabanciDizi, and DDizi
  const origFetch = globalThis.fetch;
  const mockJsonResponse = (data: unknown): Response =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const mockHtmlResponse = (body: string): Response =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  try {
    setActivePluginContext({
      schemaVersion: 1,
      id: "tmdb-unit-test",
      name: "TMDB Test",
      version: "1.0.0",
      entry: "index.ts",
      capabilities: ["vod", "search"],
      domains: ["api.themoviedb.org"],
    });

    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/search/tv")) {
        return mockJsonResponse({
          page: 1,
          total_pages: 1,
          results: [
            {
              id: 34587,
              name: "Kurtlar Vadisi",
              original_language: "tr",
              origin_country: ["TR"],
              genre_ids: [10759, 18, 80],
              first_air_date: "2003-01-15",
            },
            {
              id: 46260,
              name: "Naruto",
              original_language: "ja",
              origin_country: ["JP"],
              genre_ids: [16, 10759],
              first_air_date: "2002-10-03",
            },
          ],
        });
      }
      if (url.includes("/tv/46260/season/1")) {
        return mockJsonResponse({
          episodes: [{ season_number: 1, episode_number: 1, name: "Enter Naruto" }],
        });
      }
      if (url.includes("/tv/46260/season/2")) {
        return mockJsonResponse({
          episodes: [{ season_number: 2, episode_number: 1, name: "Season 2 Premiere" }],
        });
      }
      if (url.includes("/tv/46260")) {
        return mockJsonResponse({
          id: 46260,
          name: "Naruto",
          original_name: "NARUTO -ナルト-",
          original_language: "ja",
          origin_country: ["JP"],
          genres: [{ id: 16, name: "Animation" }],
          seasons: [
            { season_number: 0, name: "Specials", episode_count: 5 },
            { season_number: 1, name: "1. Sezon", episode_count: 1 },
            { season_number: 2, name: "2. Sezon", episode_count: 1 },
          ],
        });
      }
      throw new Error(`Unexpected mocked TMDB URL: ${url}`);
    }) as typeof fetch;

    const animeSearch = await tmdbSearch({
      idPrefix: "anizm",
      query: "Kurtlar Vadisi",
      mediaType: "series",
      isAnime: true,
      page: 1,
    });
    assert.equal(animeSearch.items.length, 1);
    assert.equal(animeSearch.items[0]?.title, "Naruto");

    const narutoDetail = await tmdbBuildMediaDetail({
      nativeId: "anthology-plus:anime:46260",
      preferType: "series",
      isAnime: true,
      streamIdBuilder: (identity, s, e) => `anthology-plus:series:${identity.tmdbId}:${s}:${e}`,
    });
    assert.ok(narutoDetail);
    assert.equal(narutoDetail.seasons?.length, 2);
    assert.equal(narutoDetail.episodes?.length, 2);
    assert.deepEqual(
      narutoDetail.episodes?.map((ep) => ep.season),
      [1, 2],
    );

    // 12. YabanciDizi poster variants + wildcard vidmoly subdomain
    const ydManifest = JSON.parse(
      nodeFs.readFileSync(
        nodePath.resolve(import.meta.dirname, "..", "plugins/yabancidizi/manifest.json"),
        "utf8",
      ),
    ) as PluginManifest;
    setActivePluginContext(ydManifest);
    clearConfigCache();

    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("ww547.vidmoly.to")) {
        return mockHtmlResponse("<html><body>ok</body></html>");
      }
      if (url.startsWith("https://yabancidizi.news")) {
        return mockHtmlResponse(`
          <html><body>
            <div class="poster-long">
              <a href="/dizi/dizi-bir">
                <img data-lazy="/uploads/series/dizi-bir" alt="Dizi Bir" />
                <h2>Dizi Bir</h2>
              </a>
            </div>
            <div class="poster-long" style="background-image:url('https://image.tmdb.org/t/p/w500/abc.jpg')">
              <a href="/dizi/dizi-iki">
                <h2>Dizi İki</h2>
              </a>
            </div>
            <div class="poster-long" data-bg="//yabancidizi.news/uploads/series/dizi-uc.webp">
              <a href="/dizi/dizi-uc">
                <h2>Dizi Üç</h2>
              </a>
            </div>
          </body></html>
        `);
      }
      throw new Error(`Unexpected mocked YabanciDizi URL: ${url}`);
    }) as typeof fetch;

    const vidmolyProbe = await http.get("https://ww547.vidmoly.to/embed-abc.html");
    assert.equal(vidmolyProbe.status, 200);

    const { default: ydPlugin } = await import("../plugins/yabancidizi/index.ts");
    const ydFeed = await ydPlugin.getHomeFeed?.();
    const ydItems = ydFeed?.sections[0]?.items ?? [];
    assert.equal(ydItems.length, 3);
    assert.equal(ydItems[0]?.poster, "https://yabancidizi.news/uploads/series/dizi-bir");
    assert.equal(ydItems[1]?.poster, "https://image.tmdb.org/t/p/w500/abc.jpg");
    assert.equal(ydItems[2]?.poster, "https://yabancidizi.news/uploads/series/dizi-uc.webp");

    // 13. DDizi query-filtered search & ep -> parent series multi-page upgrade
    const ddiziManifest = JSON.parse(
      nodeFs.readFileSync(
        nodePath.resolve(import.meta.dirname, "..", "plugins/ddizi/manifest.json"),
        "utf8",
      ),
    ) as PluginManifest;
    setActivePluginContext(ddiziManifest);
    clearConfigCache();

    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/arama/")) {
        return mockHtmlResponse(`
          <html><body>
            <ul class="diziler-listesi">
              <li><a href="https://www.ddizi.tel/diziler/99/test-dizisi-son-bolum-izle">Test Dizisi</a></li>
              <li><a href="https://www.ddizi.tel/diziler/88/alakasiz-show-son-bolum-izle">Alakasız Show</a></li>
            </ul>
            <div class="dizi-boxpost">
              <a href="https://www.ddizi.tel/izle/100/test-dizisi-2-bolum-izle.htm">
                <img src="/diziresimleri/test-dizisi.jpg" />
                Test Dizisi 2.Bölüm
              </a>
            </div>
          </body></html>
        `);
      }
      if (url.includes("/izle/100/test-dizisi-2-bolum-izle.htm")) {
        return mockHtmlResponse(`
          <html><body>
            <h2><a class="active" href="https://www.ddizi.tel/diziler/99/test-dizisi-son-bolum-izle">Test Dizisi Dizi Sayfası</a></h2>
          </body></html>
        `);
      }
      if (url.endsWith("/diziler/99/test-dizisi-son-bolum-izle")) {
        return mockHtmlResponse(`
          <html><body>
            <h1>Test Dizisi</h1>
            <div class="dizi-boxpost-cat">
              <a href="https://www.ddizi.tel/izle/100/test-dizisi-2-bolum-izle.htm">
                <img src="/diziresimleri/test-dizisi.jpg" />
                Test Dizisi 2.Bölüm
              </a>
            </div>
            <div class="pagination">
              <a href="https://www.ddizi.tel/diziler/99/test-dizisi-son-bolum-izle/sayfa-1">2</a>
            </div>
          </body></html>
        `);
      }
      if (url.endsWith("/sayfa-1")) {
        return mockHtmlResponse(`
          <html><body>
            <div class="dizi-boxpost-cat">
              <a href="https://www.ddizi.tel/izle/99/test-dizisi-1-bolum-izle.htm">
                <img src="/diziresimleri/test-dizisi.jpg" />
                Test Dizisi 1.Bölüm
              </a>
            </div>
          </body></html>
        `);
      }
      throw new Error(`Unexpected mocked DDizi URL: ${url}`);
    }) as typeof fetch;

    const { default: ddiziPlugin } = await import("../plugins/ddizi/index.ts");
    const ddiziSearch = await ddiziPlugin.search?.("Test Dizisi", {}, 1);
    assert.equal(ddiziSearch?.items.length, 1);
    assert.equal(ddiziSearch?.items[0]?.title, "Test Dizisi");

    const ddiziDet = await ddiziPlugin.getDetails?.(
      "ep:https://www.ddizi.tel/izle/100/test-dizisi-2-bolum-izle.htm",
    );
    assert.equal(ddiziDet?.episodes?.length, 2);
    assert.deepEqual(
      ddiziDet?.episodes?.map((ep) => ep.episode),
      [1, 2],
    );
  } finally {
    globalThis.fetch = origFetch;
    clearConfigCache();
  }

  console.log("All offline unit assertions passed.");
}

await runTests();
