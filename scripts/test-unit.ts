import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { installVesselMockHooks, setActivePluginContext } from "./vessel-mock.ts";

installVesselMockHooks();

const { http, html, crypto, storage, unpack, evalWithEnv } = await import("vessel");
const { clearConfigCache, configString, readToggleSetting } = await import("../core/config.ts");
const { SEICODE_TMDB_MAP } = await import("../core/exact-tmdb-sources.ts");
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

  console.log("All offline unit assertions passed.");
}

await runTests();
