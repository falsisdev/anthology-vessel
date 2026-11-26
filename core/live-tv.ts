import { crypto, storage } from "vessel";
import type {
  HomeSection,
  MediaDetail,
  MediaSummary,
  StreamCandidate,
} from "vessel";
import { configNumber, configString } from "./config.ts";
import { formatChannelSynopsis } from "./epg.ts";
import {
  DEFAULT_USER_AGENT,
  fetchJson,
  fetchText,
  postForm,
  safeRequest,
} from "./http.ts";
import { createStream } from "./quality.ts";
import { ultraClean } from "./text.ts";
import { getKoolKeyByUrlOrId, resolveAllKoolStreams } from "./kool.ts";
import { resolveYouTubeInnertube } from "../extractors/youtube.ts";

export interface LiveChannelEntry {
  id: string;
  sectionId: string;
  sectionTitle: string;
  name: string;
  group: string;
  logo: string;
  tvgId?: string;
  lang: string;
  urls: string[];
  namedSources: Array<{ name: string; url: string }>;
}

interface SportMapping {
  name: string;
  taraftarium?: string;
  ardasports?: string;
  alemdarsport?: string;
  mahsunsports?: string;
  papazsports?: string;
}

interface T24BaseState {
  api: string;
  site: string;
  at: number;
}

const DEFAULT_TV_LOGO =
  "https://raw.githubusercontent.com/falsisdev/anthology-vessel/main/assets/canli/default_tv.png";
const DEFAULT_M3U_REMOTE =
  "https://raw.githubusercontent.com/falsisdev/anthology-vessel/main/data/canli.m3u";
const RESOLVER_TTL_MS = 15 * 60 * 1000;
const CHANNELS_TTL_MS = 5 * 60 * 1000;

const VERIFIED_BACKUPS: Record<string, string> = {
  trtspor: "https://tv-trtspor1.medya.trt.com.tr/master.m3u8",
  trtsporyildiz: "https://tv-trtspor2.medya.trt.com.tr/master.m3u8",
  trt1: "https://tv-trt1.medya.trt.com.tr/master.m3u8",
  aspor: "https://trkvz-live.ercdn.net/asportv/asportv.m3u8",
  fbtv: "http://1hskrdto.rocketcdn.com/fenerbahcetv.smil/playlist.m3u8",
  tv85: "https://tv8.daioncdn.net/tv8bucuk/tv8bucuk.m3u8?app=tv8bucuk_web&ce=3",
};

const SPORT_MAP: Record<string, SportMapping> = {
  beinsports1: { name: "BEIN SPORTS 1", taraftarium: "bein-sports-1", ardasports: "bein-sports-1", alemdarsport: "bein1", mahsunsports: "androstreamlivebs1", papazsports: "100001" },
  beinsports2: { name: "BEIN SPORTS 2", taraftarium: "bein-sports-2", ardasports: "bein-sports-2", alemdarsport: "bein2", mahsunsports: "androstreamlivebs2", papazsports: "100002" },
  beinsports3: { name: "BEIN SPORTS 3", taraftarium: "bein-sports-3", ardasports: "bein-sports-3", alemdarsport: "bein3", mahsunsports: "androstreamlivebs3", papazsports: "100003" },
  beinsports4: { name: "BEIN SPORTS 4", taraftarium: "bein-sports-4", ardasports: "bein-sports-4", alemdarsport: "bein4", mahsunsports: "androstreamlivebs4", papazsports: "100004" },
  beinsports5: { name: "BEIN SPORTS 5", taraftarium: "bein-sports-5", ardasports: "bein-sports-5", alemdarsport: "bein5", mahsunsports: "androstreamlivebs5", papazsports: "100005" },
  beinsportsmax1: { name: "BEIN SPORTS MAX 1", taraftarium: "bein-sports-max-1", ardasports: "bein-sports-max-1", alemdarsport: "beinmax1", mahsunsports: "androstreamlivebsm1", papazsports: "100006" },
  beinsportsmax2: { name: "BEIN SPORTS MAX 2", taraftarium: "bein-sports-max-2", ardasports: "bein-sports-max-2", alemdarsport: "beinmax2", mahsunsports: "androstreamlivebsm2", papazsports: "100007" },
  ssport: { name: "S SPORT", taraftarium: "s-sport", ardasports: "s-sport", alemdarsport: "ssport1", mahsunsports: "androstreamlivess1", papazsports: "100010" },
  ssport1: { name: "S SPORT 1", taraftarium: "s-sport", ardasports: "s-sport", alemdarsport: "ssport1", mahsunsports: "androstreamlivess1", papazsports: "100010" },
  ssport2: { name: "S SPORT 2", taraftarium: "s-sport-2", ardasports: "s-sport-2", alemdarsport: "ssport2", mahsunsports: "androstreamlivess2", papazsports: "100011" },
  ssportplus: { name: "S SPORT PLUS", mahsunsports: "androstreamlivessplus1", alemdarsport: "ssport1" },
  tivibuspor: { name: "TIVIBU SPOR", alemdarsport: "tivibu1", mahsunsports: "androstreamlivets", papazsports: "100021" },
  tivibuspor1: { name: "TIVIBU SPOR 1", alemdarsport: "tivibu1", mahsunsports: "androstreamlivets1", papazsports: "100021" },
  tivibuspor2: { name: "TIVIBU SPOR 2", alemdarsport: "tivibu2", mahsunsports: "androstreamlivets2", papazsports: "100022" },
  tivibuspor3: { name: "TIVIBU SPOR 3", alemdarsport: "tivibu3", mahsunsports: "androstreamlivets3", papazsports: "100023" },
  tivibuspor4: { name: "TIVIBU SPOR 4", alemdarsport: "tivibu4", mahsunsports: "androstreamlivets4", papazsports: "100024" },
  smartspor1: { name: "SMART SPOR 1", alemdarsport: "sporsmart", mahsunsports: "androstreamlivesm1", papazsports: "100030" },
  smartspor2: { name: "SMART SPOR 2", alemdarsport: "sporsmart2", mahsunsports: "androstreamlivesm2", papazsports: "100031" },
  trtspor: { name: "TRT SPOR", taraftarium: "trt-spor", ardasports: "trt-spor", alemdarsport: "trtspor" },
  trtsporyildiz: { name: "TRT SPOR YILDIZ", alemdarsport: "trtspor2" },
  trt1: { name: "TRT 1", taraftarium: "trt-1", ardasports: "trt-1", alemdarsport: "trt1" },
  aspor: { name: "A SPOR", taraftarium: "a-spor", ardasports: "a-spor", alemdarsport: "aspor", papazsports: "100052" },
  tv85: { name: "TV8.5", alemdarsport: "tv85", papazsports: "100051" },
  nbatv: { name: "NBA TV", papazsports: "100053" },
  eurosport1: { name: "EUROSPORT 1", mahsunsports: "androstreamlivees1", papazsports: "100056" },
  eurosport2: { name: "EUROSPORT 2", mahsunsports: "androstreamlivees2", papazsports: "100057" },
  cbcsport: { name: "CBC SPORT", mahsunsports: "androstreamlivecbcs" },
  idmantv: { name: "IDMAN TV", mahsunsports: "androstreamliveidm" },
  exxentv: { name: "EXXEN TV", mahsunsports: "androstreamliveexn" },
  exxensports1: { name: "EXXEN SPORTS 1", mahsunsports: "androstreamliveexn1" },
  exxensports2: { name: "EXXEN SPORTS 2", mahsunsports: "androstreamliveexn2" },
  exxensports3: { name: "EXXEN SPORTS 3", mahsunsports: "androstreamliveexn3" },
  exxensports4: { name: "EXXEN SPORTS 4", mahsunsports: "androstreamliveexn4" },
  exxensports5: { name: "EXXEN SPORTS 5", mahsunsports: "androstreamliveexn5" },
  exxensports6: { name: "EXXEN SPORTS 6", mahsunsports: "androstreamliveexn6" },
  exxensports7: { name: "EXXEN SPORTS 7", mahsunsports: "androstreamliveexn7" },
  exxensports8: { name: "EXXEN SPORTS 8", mahsunsports: "androstreamliveexn8" },
  tabiispor: { name: "TABII SPOR", mahsunsports: "androstreamlivetb" },
  tabiispor1: { name: "TABII SPOR 1", mahsunsports: "androstreamlivetb1" },
  tabiispor2: { name: "TABII SPOR 2", mahsunsports: "androstreamlivetb2" },
  tabiispor3: { name: "TABII SPOR 3", mahsunsports: "androstreamlivetb3" },
  tabiispor4: { name: "TABII SPOR 4", mahsunsports: "androstreamlivetb4" },
  tabiispor5: { name: "TABII SPOR 5", mahsunsports: "androstreamlivetb5" },
  tabiispor6: { name: "TABII SPOR 6", mahsunsports: "androstreamlivetb6" },
  tabiispor7: { name: "TABII SPOR 7", mahsunsports: "androstreamlivetb7" },
  tabiispor8: { name: "TABII SPOR 8", mahsunsports: "androstreamlivetb8" },
};

const SECTION_ORDER: Array<{ id: string; title: string }> = [
  { id: "ulusal", title: "Ulusal Kanallar" },
  { id: "spor", title: "Spor Kanalları" },
  { id: "haber", title: "Haber Kanalları" },
  { id: "sinema", title: "Sinema Kanalları" },
  { id: "belgesel-cocuk", title: "Belgesel & Çocuk" },
  { id: "muzik-eglence", title: "Müzik & Eğlence" },
  { id: "yerel-diger", title: "Yerel & Diğer Kanallar" },
];

let cachedChannels: LiveChannelEntry[] | null = null;
let channelsFetchedAt = 0;
let t24State: T24BaseState | null = null;
let cachedAlemdarTemplate: { template: string; at: number } | null = null;
let cachedMahsunBase: { base: string; at: number } | null = null;

function mapGroupToSection(group: string): { id: string; title: string } {
  const upper = group.toUpperCase();
  if (upper.includes("ULUSAL")) return SECTION_ORDER[0]!;
  if (upper.includes("SPOR")) return SECTION_ORDER[1]!;
  if (upper.includes("HABER")) return SECTION_ORDER[2]!;
  if (upper.includes("SİNEMA") || upper.includes("SINEMA")) return SECTION_ORDER[3]!;
  if (upper.includes("BELGESEL") || upper.includes("ÇOCUK") || upper.includes("COCUK")) {
    return SECTION_ORDER[4]!;
  }
  if (upper.includes("MÜZİK") || upper.includes("MUZIK") || upper.includes("EĞLENCE") || upper.includes("EGLENCE")) {
    return SECTION_ORDER[5]!;
  }
  return SECTION_ORDER[6]!;
}

function parseExtInfAttr(line: string, attr: string): string {
  const re = new RegExp(`${attr}="([^"]*)"`, "i");
  return re.exec(line)?.[1]?.trim() ?? "";
}

function makeChannelId(name: string, tvgId: string): string {
  const cleaned = (tvgId || name)
    .toLowerCase()
    .replace(/\.tr$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return cleaned || "kanal";
}

export function parseLiveM3uText(rawM3u: string): LiveChannelEntry[] {
  const lines = rawM3u.split(/\r?\n/);
  const byKey = new Map<string, LiveChannelEntry>();
  const order: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("#EXTINF")) continue;

    let streamUrl = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = (lines[j] ?? "").trim();
      if (!next || next.startsWith("#")) {
        if (next.startsWith("#EXTINF")) break;
        continue;
      }
      streamUrl = next;
      i = j;
      break;
    }
    if (!streamUrl) continue;

    const commaIdx = line.lastIndexOf(",");
    const title = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : "Kanal";
    const tvgName = parseExtInfAttr(line, "tvg-name") || title;
    const tvgId = parseExtInfAttr(line, "tvg-id") || undefined;
    const logo = parseExtInfAttr(line, "tvg-logo") || DEFAULT_TV_LOGO;
    const group = parseExtInfAttr(line, "group-title") || "Genel";
    const lang = parseExtInfAttr(line, "tvg-lang") || "tr";
    const backup = parseExtInfAttr(line, "tvg-backup");
    const backup2 = parseExtInfAttr(line, "tvg-backup2");
    const rawSrcs = parseExtInfAttr(line, "tvg-src");

    const section = mapGroupToSection(group);
    const id = makeChannelId(tvgName, tvgId ?? "");
    const key = `${section.id}:${id}`;

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        id,
        sectionId: section.id,
        sectionTitle: section.title,
        name: title.replace(/\s+HD$/i, "").trim() || tvgName,
        group,
        logo,
        tvgId,
        lang,
        urls: [],
        namedSources: [],
      };
      byKey.set(key, entry);
      order.push(key);
    }

    if (!entry.urls.includes(streamUrl)) entry.urls.push(streamUrl);
    for (const rawBackup of [backup, backup2]) {
      if (!rawBackup) continue;
      for (const piece of rawBackup.split("|")) {
        const clean = piece.trim();
        if (clean && !entry.urls.includes(clean)) entry.urls.push(clean);
      }
    }

    if (rawSrcs) {
      const parts = rawSrcs.split("|");
      for (let pi = 0; pi + 1 < parts.length; pi += 2) {
        const sName = (parts[pi] ?? "").trim();
        const sUrl = (parts[pi + 1] ?? "").trim();
        if (sName && sUrl) {
          entry.namedSources.push({ name: sName, url: sUrl });
        }
      }
    }
  }

  return order
    .map((k) => byKey.get(k))
    .filter((v): v is LiveChannelEntry => Boolean(v));
}

export async function loadLiveChannels(
  embeddedFallback: readonly {
    id: string;
    name: string;
    group: string;
    logo: string;
    tvgId?: string;
    lang: string;
    urls: string[];
  }[],
): Promise<LiveChannelEntry[]> {
  const now = Date.now();
  if (cachedChannels && now - channelsFetchedAt < CHANNELS_TTL_MS) {
    return cachedChannels;
  }

  const remoteUrl = await configString("urls.live.m3u_remote", DEFAULT_M3U_REMOTE);
  const remoteText = await fetchText(remoteUrl, { timeoutMs: 7_000 });
  if (remoteText && remoteText.includes("#EXTINF")) {
    const parsed = parseLiveM3uText(remoteText);
    if (parsed.length > 0) {
      cachedChannels = parsed;
      channelsFetchedAt = now;
      return parsed;
    }
  }

  const fallbackEntries: LiveChannelEntry[] = [];
  for (const ch of embeddedFallback) {
    const section = mapGroupToSection(ch.group);
    fallbackEntries.push({
      id: ch.id,
      sectionId: section.id,
      sectionTitle: section.title,
      name: ch.name,
      group: ch.group,
      logo: ch.logo || DEFAULT_TV_LOGO,
      tvgId: ch.tvgId,
      lang: ch.lang || "tr",
      urls: [...ch.urls],
      namedSources: [],
    });
  }

  cachedChannels = fallbackEntries;
  channelsFetchedAt = now;
  return fallbackEntries;
}

export function extractCanonicalSportKey(raw: string): string {
  let cleaned = raw
    .toLowerCase()
    .replace(/^tv[:_]/, "")
    .replace(/\.tr$/, "")
    .replace(/[^a-z0-9]/g, "");
  if (cleaned.startsWith("tv") && cleaned.length > 3) {
    cleaned = cleaned.slice(2);
  }
  if (cleaned.endsWith("tr") && cleaned.length > 5) {
    cleaned = cleaned.slice(0, -2);
  }

  if (/^beinsport?1/.test(cleaned)) return "beinsports1";
  if (/^beinsport?2/.test(cleaned)) return "beinsports2";
  if (/^beinsport?3/.test(cleaned)) return "beinsports3";
  if (/^beinsport?4/.test(cleaned)) return "beinsports4";
  if (/^beinsport?5/.test(cleaned)) return "beinsports5";
  if (/^beinsport?max1/.test(cleaned)) return "beinsportsmax1";
  if (/^beinsport?max2/.test(cleaned)) return "beinsportsmax2";
  if (/^ssport1?$/.test(cleaned)) return "ssport";
  if (/^ssport2$/.test(cleaned)) return "ssport2";
  if (/^ssportplus$/.test(cleaned)) return "ssportplus";
  if (/^(?:24|24tv|kanal24)$/.test(cleaned)) return "kanal24";
  if (/^tivibu(?:spor)?1?$/.test(cleaned)) return "tivibuspor1";
  if (/^tivibu(?:spor)?2$/.test(cleaned)) return "tivibuspor2";
  if (/^tivibu(?:spor)?3$/.test(cleaned)) return "tivibuspor3";
  if (/^tivibu(?:spor)?4$/.test(cleaned)) return "tivibuspor4";
  if (/^smartspor1|^sporsmart1?$/.test(cleaned)) return "smartspor1";
  if (/^smartspor2|^sporsmart2/.test(cleaned)) return "smartspor2";
  if (/^trtspor$/.test(cleaned)) return "trtspor";
  if (/^trtsporyildiz/.test(cleaned)) return "trtsporyildiz";
  if (/^aspor/.test(cleaned)) return "aspor";
  if (/^tv85|tv8bucuk/.test(cleaned)) return "tv85";
  const exxen = /^exxen(?:sports?)?([1-8])$/.exec(cleaned);
  if (exxen?.[1]) return `exxensports${exxen[1]}`;
  const tabii = /^tabii(?:spor)?([1-8])$/.exec(cleaned);
  if (tabii?.[1]) return `tabiispor${tabii[1]}`;

  return cleaned;
}

function findSportMapping(rawStr: string): SportMapping | null {
  const k = rawStr
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^tv/, "")
    .replace(/tr$/, "");
  if (SPORT_MAP[k]) return SPORT_MAP[k]!;

  if (k.includes("beinsportsmax1") || k.includes("beinmax1")) return SPORT_MAP["beinsportsmax1"]!;
  if (k.includes("beinsportsmax2") || k.includes("beinmax2")) return SPORT_MAP["beinsportsmax2"]!;
  if (k.includes("beinsport1") || k.includes("bein1")) return SPORT_MAP["beinsports1"]!;
  if (k.includes("beinsport2") || k.includes("bein2")) return SPORT_MAP["beinsports2"]!;
  if (k.includes("beinsport3") || k.includes("bein3")) return SPORT_MAP["beinsports3"]!;
  if (k.includes("beinsport4") || k.includes("bein4")) return SPORT_MAP["beinsports4"]!;
  if (k.includes("beinsport5") || k.includes("bein5")) return SPORT_MAP["beinsports5"]!;
  if (k.includes("ssportplus")) return SPORT_MAP["ssportplus"]!;
  if (k.includes("ssport2")) return SPORT_MAP["ssport2"]!;
  if (k.includes("ssport")) return SPORT_MAP["ssport1"]!;
  if (k.includes("tivibu1")) return SPORT_MAP["tivibuspor1"]!;
  if (k.includes("tivibu2")) return SPORT_MAP["tivibuspor2"]!;
  if (k.includes("tivibu3")) return SPORT_MAP["tivibuspor3"]!;
  if (k.includes("tivibu4")) return SPORT_MAP["tivibuspor4"]!;
  if (k.includes("tivibu")) return SPORT_MAP["tivibuspor"]!;
  if (k.includes("smartspor2") || k.includes("sporsmart2")) return SPORT_MAP["smartspor2"]!;
  if (k.includes("smartspor") || k.includes("sporsmart")) return SPORT_MAP["smartspor1"]!;
  if (k.includes("trtsporyildiz")) return SPORT_MAP["trtsporyildiz"]!;
  if (k.includes("trtspor")) return SPORT_MAP["trtspor"]!;
  if (k.includes("aspor")) return SPORT_MAP["aspor"]!;
  if (k.includes("tv85") || k.includes("tv8bucuk")) return SPORT_MAP["tv85"]!;
  if (k.includes("nba")) return SPORT_MAP["nbatv"]!;
  if (k.includes("eurosport2")) return SPORT_MAP["eurosport2"]!;
  if (k.includes("eurosport")) return SPORT_MAP["eurosport1"]!;
  if (k.includes("cbc")) return SPORT_MAP["cbcsport"]!;
  if (k.includes("idman")) return SPORT_MAP["idmantv"]!;
  if (k.includes("exxen")) return SPORT_MAP["exxentv"]!;

  for (const [mk, mv] of Object.entries(SPORT_MAP)) {
    if (mk.length >= 4 && k.startsWith(mk) && (k === mk || !/^\d/.test(k.slice(mk.length)))) {
      return mv;
    }
  }
  return null;
}

async function resolveTaraftariumBase(): Promise<T24BaseState> {
  const now = Date.now();
  if (t24State && now - t24State.at < RESOLVER_TTL_MS) {
    return t24State;
  }
  const site = await configString(
    "urls.live.taraftarium.base",
    "https://taraftarium24-246.top/",
  );
  const api = await configString(
    "urls.live.taraftarium.api_base",
    "https://teletv15.top",
  );
  const baseNum = await configNumber("urls.live.taraftarium.base_number", 246);

  const probe = await safeRequest(`${api.replace(/\/+$/, "")}/load/channels.php`, {
    timeoutMs: 3_500,
  });
  if (probe && probe.status === 200) {
    t24State = { api: api.replace(/\/+$/, ""), site, at: now };
    return t24State;
  }

  for (const offset of [0, 1, -1, 2]) {
    const candSite = `https://taraftarium24-${baseNum + offset}.top/`;
    const html = await fetchText(candSite, { timeoutMs: 3_000 });
    if (!html) continue;
    const apiMatch =
      /https:\/\/teletv\d+\.top/i.exec(html) ??
      /fetch\(['"](https:\/\/[^'"]*teletv[^'"]*top)/i.exec(html);
    t24State = {
      api: (apiMatch?.[1] ?? apiMatch?.[0] ?? api).replace(/\/+$/, ""),
      site: candSite,
      at: now,
    };
    return t24State;
  }

  t24State = { api: api.replace(/\/+$/, ""), site, at: now };
  return t24State;
}

async function fetchTaraftariumStream(
  channelId: string,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const base = await resolveTaraftariumBase();
  const data = await fetchJson<{ deismackanal?: string }>(
    `${base.api}/load/yayinlink.php?id=${encodeURIComponent(channelId)}`,
    { timeoutMs: 3_500 },
  );
  if (!data?.deismackanal || !data.deismackanal.includes("m3u8")) return null;
  return {
    url: data.deismackanal.replace(/edge4\./g, "edge3."),
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Referer: base.site,
      Origin: base.site.replace(/\/+$/, ""),
    },
  };
}

async function fetchArdaSportsStream(
  channelId: string,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const site = (
    await configString("urls.live.ardasports.base", "https://selcuksporkral2.cc")
  ).replace(/\/+$/, "");
  const watchUrl = `${site}/channel/watch/${encodeURIComponent(channelId)}`;
  const watchHtml = await fetchText(watchUrl, {
    timeoutMs: 3_500,
    headers: { Referer: `${site}/canli-izle/${encodeURIComponent(channelId)}` },
  });
  if (!watchHtml) return null;

  const lsMatch = /src="(\/loadstream\.php\?[^"]+)"/.exec(watchHtml);
  if (!lsMatch?.[1]) return null;
  const lsHtml = await fetchText(`${site}${lsMatch[1]}`, {
    timeoutMs: 3_500,
    headers: { Referer: watchUrl },
  });
  if (!lsHtml) return null;

  const b64Match =
    /['"]([A-Za-z0-9+/=]{40,})\|atob/i.exec(lsHtml) ??
    /atob\(['"]([A-Za-z0-9+/=]+)['"]\)/.exec(lsHtml);
  if (!b64Match?.[1]) return null;

  let decoded = "";
  try {
    decoded = crypto.base64Decode(b64Match[1]);
  } catch {
    return null;
  }
  const streamMatch = /https?:\/\/[^"'\s\\]+\.m3u8/.exec(decoded);
  if (!streamMatch?.[0]) return null;

  return {
    url: streamMatch[0],
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Referer: site,
      Origin: site,
    },
  };
}

async function fetchAlemdarStream(
  channelId: string,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const site = (
    await configString("urls.live.alemdarsport.base", "https://alemdarsport.cfd")
  ).replace(/\/+$/, "");
  const now = Date.now();
  if (cachedAlemdarTemplate && now - cachedAlemdarTemplate.at < RESOLVER_TTL_MS) {
    return {
      url: cachedAlemdarTemplate.template.replace("${cid}", channelId),
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: site,
        Origin: site,
      },
    };
  }

  const html = await fetchText(
    `${site}/channel.php?id=${encodeURIComponent(channelId)}`,
    { timeoutMs: 3_500 },
  );
  if (!html) return null;
  const m = /flotfUrl\s*=\s*[`'"](https:\/\/[^`'"]+index\.m3u8)/.exec(html);
  if (!m?.[1]) return null;

  cachedAlemdarTemplate = { template: m[1], at: now };
  return {
    url: m[1].replace("${cid}", channelId),
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Referer: site,
      Origin: site,
    },
  };
}

async function fetchMahsunStream(
  channelId: string,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const now = Date.now();
  let base = cachedMahsunBase?.base ?? "";
  if (!cachedMahsunBase || now - cachedMahsunBase.at >= RESOLVER_TTL_MS) {
    const site = (
      await configString("urls.live.mahsunsports.base", "https://mahsunsports58.xyz")
    ).replace(/\/+$/, "");
    const html = await fetchText(`${site}/event.html?id=androstreamlivebs1`, {
      timeoutMs: 3_500,
    });
    const m = html ? /["'](https:\/\/andro\.[^"']+\/checklist\/)["']/.exec(html) : null;
    base = m?.[1] ?? "https://andro.evrenesoglu235.click/checklist/";
    cachedMahsunBase = { base, at: now };
  }

  return {
    url: `${base}${channelId}.m3u8`,
    headers: { "User-Agent": DEFAULT_USER_AGENT },
  };
}

async function fetchPapazStream(
  channelId: string,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (channelId.startsWith("http")) {
    return { url: channelId, headers: { "User-Agent": DEFAULT_USER_AGENT } };
  }
  const site = (
    await configString("urls.live.papazsports.base", "https://www.papazsports1033.pro")
  ).replace(/\/+$/, "");
  const res = await postForm(
    `${site}/auth.php`,
    { channel: channelId },
    {
      timeoutMs: 3_500,
      headers: {
        Referer: `${site}/tv/${encodeURIComponent(channelId)}`,
        Origin: site,
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );
  if (!res || res.status < 200 || res.status >= 300) return null;
  try {
    const json = res.json<{ URL?: string; TOKEN?: string }>();
    if (!json.URL || !json.TOKEN) return null;
    return {
      url: json.URL,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: `${site}/`,
        Origin: site,
        usertoken: json.TOKEN,
        pl: "PapazSports",
      },
    };
  } catch {
    return null;
  }
}

async function getPreferredSportSource(): Promise<string> {
  const preferred = await storage.getSetting<string>("preferredSportSource");
  return preferred?.trim() || "auto";
}

export function channelToMediaSummary(ch: LiveChannelEntry): MediaSummary {
  return {
    nativeId: `${ch.sectionId}:${ch.id}`,
    type: "live",
    title: ch.name,
    poster: ch.logo || DEFAULT_TV_LOGO,
  };
}

export function buildChannelDetail(ch: LiveChannelEntry): MediaDetail {
  const nativeId = `${ch.sectionId}:${ch.id}`;
  return {
    nativeId,
    type: "live",
    title: ch.name,
    synopsis: formatChannelSynopsis(ch.name, ch.sectionTitle, ch.lang),
    poster: ch.logo || DEFAULT_TV_LOGO,
    backdrop: ch.logo || DEFAULT_TV_LOGO,
    genres: [ch.sectionTitle],
    status: "ongoing",
    episodes: [
      {
        streamId: nativeId,
        season: 1,
        episode: 1,
        title: `${ch.name} • Canlı Yayın`,
        thumbnail: ch.logo || DEFAULT_TV_LOGO,
      },
    ],
  };
}

export function buildLiveHomeSections(channels: LiveChannelEntry[]): HomeSection[] {
  const grouped = new Map<string, LiveChannelEntry[]>();
  for (const ch of channels) {
    const bucket = grouped.get(ch.sectionId);
    if (bucket) bucket.push(ch);
    else grouped.set(ch.sectionId, [ch]);
  }

  const sections: HomeSection[] = [];
  for (const sec of SECTION_ORDER) {
    const list = grouped.get(sec.id);
    if (!list || list.length === 0) continue;
    sections.push({
      id: sec.id,
      title: sec.title,
      layout: "landscape",
      items: list.map(channelToMediaSummary),
    });
  }
  return sections;
}

export function findChannelByNativeId(
  channels: LiveChannelEntry[],
  rawId: string,
): LiveChannelEntry | null {
  const cleanedRaw = rawId.trim();
  const exactCombined = channels.find(
    (c) => `${c.sectionId}:${c.id}` === cleanedRaw,
  );
  if (exactCombined) return exactCombined;

  const withoutPrefix = cleanedRaw.includes(":")
    ? cleanedRaw.split(":").slice(1).join(":")
    : cleanedRaw;
  const searchKey = ultraClean(withoutPrefix);
  if (!searchKey) return null;

  for (const ch of channels) {
    if (
      ultraClean(ch.id) === searchKey ||
      ultraClean(ch.name) === searchKey
    ) {
      return ch;
    }
  }
  if (searchKey.length >= 4) {
    for (const ch of channels) {
      const cid = ultraClean(ch.id);
      const cname = ultraClean(ch.name);
      if (
        (cname.length >= 4 && (cname.includes(searchKey) || searchKey.includes(cname))) ||
        (cid.length >= 4 && (cid.includes(searchKey) || searchKey.includes(cid)))
      ) {
        return ch;
      }
    }
  }
  return null;
}

export async function resolveChannelStreams(
  ch: LiveChannelEntry,
): Promise<StreamCandidate[]> {
  const streams: StreamCandidate[] = [];
  const seenUrls = new Set<string>();
  const addUnique = (stream: StreamCandidate): void => {
    if (!stream.url || seenUrls.has(stream.url)) return;
    seenUrls.add(stream.url);
    streams.push(stream);
  };

  const preferredSource = await getPreferredSportSource();
  const isSport = ch.sectionId === "spor";
  const isPlaceholderUrl = (u: string): boolean =>
    u.includes("kool.ws/live/play/") ||
    (u.includes("/live/") && u.includes("anthology-live"));
  const placeholderUrl = ch.urls.find(isPlaceholderUrl);
  const liveKeyMatch = placeholderUrl
    ? /\/live\/([^.?/]+)\.m3u8/i.exec(placeholderUrl)
    : null;
  const koolKeyFromUrl = placeholderUrl
    ? getKoolKeyByUrlOrId(placeholderUrl) || liveKeyMatch?.[1] || ""
    : "";
  const canonicalKey = koolKeyFromUrl || extractCanonicalSportKey(ch.tvgId || ch.id || ch.name);
  const sportMap = isSport ? findSportMapping(ch.id || ch.name) : null;

  if (preferredSource !== "direct_only") {
    if (isSport && sportMap) {
      const sportTasks = [
        { id: "mahsunsports", label: "MahsunSports", priority: 115, p: sportMap.mahsunsports ? fetchMahsunStream(sportMap.mahsunsports) : Promise.resolve(null) },
        { id: "alemdarsport", label: "AlemdarSport", priority: 110, p: sportMap.alemdarsport ? fetchAlemdarStream(sportMap.alemdarsport) : Promise.resolve(null) },
        { id: "taraftarium", label: "Taraftarium24", priority: 105, p: sportMap.taraftarium ? fetchTaraftariumStream(sportMap.taraftarium) : Promise.resolve(null) },
        { id: "ardasports", label: "ArdaSports", priority: 100, p: sportMap.ardasports ? fetchArdaSportsStream(sportMap.ardasports) : Promise.resolve(null) },
        { id: "papazsports", label: "PapazSports", priority: 95, p: sportMap.papazsports ? fetchPapazStream(sportMap.papazsports) : Promise.resolve(null) },
      ];
      const [settled, koolStreams] = await Promise.all([
        Promise.all(sportTasks.map((t) => t.p)),
        canonicalKey ? resolveAllKoolStreams(canonicalKey, ch.name, ch.lang || "tr") : Promise.resolve([]),
      ]);
      for (let i = 0; i < settled.length; i++) {
        const res = settled[i];
        const task = sportTasks[i]!;
        if (!res) continue;
        const isPreferred = task.id === preferredSource;
        addUnique(
          createStream({
            url: res.url,
            kind: "hls",
            quality: "1080p",
            label: `${task.label} • ${ch.name} 1080p`,
            language: ch.lang || "tr",
            priority: isPreferred ? 200 : task.priority,
            isDefault: isPreferred,
            headers: res.headers,
            flags: ["requires_proxy"],
          }),
        );
      }
      for (const ks of koolStreams) {
        addUnique(ks);
      }
    } else if (canonicalKey) {
      const koolStreams = await resolveAllKoolStreams(canonicalKey, ch.name, ch.lang || "tr");
      for (const ks of koolStreams) {
        addUnique(ks);
      }
    }
  }

  for (let idx = 0; idx < ch.urls.length; idx++) {
    const rawUrl = ch.urls[idx]!;
    if (isPlaceholderUrl(rawUrl)) continue;
    if (rawUrl.includes("youtube.com") || rawUrl.includes("youtu.be")) {
      const yt = await resolveYouTubeInnertube(rawUrl, ch.name);
      if (yt) {
        for (const s of yt.streams) {
          addUnique({
            ...s,
            label: `${ch.name} • YouTube Canlı HD`,
            priority: s.priority ?? 85,
          });
        }
      }
      continue;
    }

    addUnique(
      createStream({
        url: rawUrl,
        quality: "1080p",
        label:
          idx === 0
            ? `${ch.name} • Doğrudan Canlı HD`
            : `${ch.name} • Yedek Yayın #${idx}`,
        language: ch.lang || "tr",
        priority: idx === 0 ? 100 : 75,
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "*/*",
        },
      }),
    );
  }

  for (const ns of ch.namedSources) {
    addUnique(
      createStream({
        url: ns.url,
        quality: "1080p",
        label: `${ch.name} • ${ns.name}`,
        language: ch.lang || "tr",
        priority: 70,
        headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "*/*" },
      }),
    );
  }

  const verifiedKey = ch.id.toLowerCase().replace(/[^a-z0-9]/g, "");
  const verifiedUrl = VERIFIED_BACKUPS[verifiedKey];
  if (verifiedUrl) {
    addUnique(
      createStream({
        url: verifiedUrl,
        kind: "hls",
        quality: "1080p",
        label: `${ch.name} • Doğrulanmış Resmi Yedek`,
        language: ch.lang || "tr",
        priority: 95,
        headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "*/*" },
      }),
    );
  }

  streams.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  if (streams.length > 0 && !streams.some((s) => s.isDefault)) {
    streams[0]!.isDefault = true;
  }

  return streams;
}
