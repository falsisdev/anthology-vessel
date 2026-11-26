import type { StreamCandidate } from "vessel";
import { configString } from "./config.ts";
import {
  DEFAULT_USER_AGENT,
  fetchJson,
  rethrowIfDomainBlocked,
} from "./http.ts";
import { KOOL_CATALOG, type KoolCatalogVariant } from "./kool-catalog.ts";
import { createStream } from "./quality.ts";

interface KoolResolveResponse {
  url?: string;
  headers?: Record<string, string>;
}

interface ResolvedKoolVariant {
  url: string;
  headers: Record<string, string>;
  pool: string;
  quality: number;
  rawName: string;
}

const byKey = new Map<string, KoolCatalogVariant[]>();
const keyById = new Map<string, string>();
let initialized = false;

function poolPriority(pool: string): number {
  if (pool === "kool1") return 1;
  if (pool === "kool6") return 2;
  if (pool === "kool7") return 3;
  return 9;
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  for (const ch of KOOL_CATALOG) {
    if (!ch.key || ch.variants.length === 0) continue;
    const sorted = [...ch.variants].sort((a, b) => {
      if (a.quality !== b.quality) return b.quality - a.quality;
      return poolPriority(a.pool) - poolPriority(b.pool);
    });
    byKey.set(ch.key, sorted);
    for (const v of sorted) {
      if (v.koolId) keyById.set(v.koolId, ch.key);
    }
  }
}

export function getKoolKeyByUrlOrId(urlOrId: string): string {
  ensureInit();
  if (!urlOrId) return "";
  const m = /\/live\/play\/(\d+)/.exec(urlOrId);
  const id = m?.[1] ?? urlOrId.trim();
  return keyById.get(id) ?? "";
}

export function getKoolPools(channelKey: string): string[] {
  ensureInit();
  const variants = byKey.get(channelKey);
  if (!variants || variants.length === 0) return [];
  const pools: string[] = [];
  for (const p of ["kool1", "kool6", "kool7"]) {
    if (variants.some((v) => v.pool === p)) {
      pools.push(p);
    }
  }
  return pools;
}

async function resolveSingleVariant(
  koolBase: string,
  variant: KoolCatalogVariant,
): Promise<ResolvedKoolVariant | null> {
  if (!variant.koolId) return null;
  const playUrl = `${koolBase}/live/play/${variant.koolId}`;
  const apiUrl = `${koolBase}/live/resolve?region=TR&language=tr&url=${encodeURIComponent(playUrl)}`;

  try {
    const data = await fetchJson<KoolResolveResponse>(apiUrl, {
      timeoutMs: 4_500,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: `${koolBase}/`,
        Accept: "application/json, */*",
      },
    });
    if (!data?.url) return null;

    const headers: Record<string, string> = {
      "User-Agent": DEFAULT_USER_AGENT,
      ...(data.headers ?? {}),
    };
    return {
      url: data.url,
      headers,
      pool: variant.pool || "kool1",
      quality: variant.quality || 720,
      rawName: variant.rawName,
    };
  } catch (err) {
    rethrowIfDomainBlocked(err);
    return null;
  }
}

async function resolvePool(
  channelKey: string,
  pool: string,
  koolBase: string,
): Promise<ResolvedKoolVariant | null> {
  ensureInit();
  const all = byKey.get(channelKey);
  if (!all || all.length === 0) return null;

  const candidates = all.filter((v) => v.pool === pool);
  const maxTries = Math.min(candidates.length, 2);

  for (let i = 0; i < maxTries; i++) {
    const variant = candidates[i];
    if (!variant) continue;
    const resolved = await resolveSingleVariant(koolBase, variant);
    if (resolved?.url) {
      return resolved;
    }
  }
  return null;
}

export async function resolveAllKoolStreams(
  channelKey: string,
  channelName: string,
  lang = "tr",
): Promise<StreamCandidate[]> {
  ensureInit();
  if (!channelKey || !byKey.has(channelKey)) return [];

  const koolBase = (
    await configString("urls.live.kool.base", "https://kool.ws")
  ).replace(/\/+$/, "");
  const pools = getKoolPools(channelKey);
  if (pools.length === 0) return [];

  const settled = await Promise.all(
    pools.map((pool) => resolvePool(channelKey, pool, koolBase)),
  );

  const streams: StreamCandidate[] = [];
  const seen = new Set<string>();
  for (const res of settled) {
    if (!res?.url || seen.has(res.url)) continue;
    seen.add(res.url);

    const poolNum =
      res.pool === "kool6" ? "6" : res.pool === "kool7" ? "7" : "1";
    const qualityStr =
      res.quality >= 2160 ? "4K" : res.quality >= 1080 ? "1080p" : "720p";

    streams.push(
      createStream({
        url: res.url,
        kind: "hls",
        quality: qualityStr,
        label: `Kool.ws • Sunucu ${poolNum} • ${channelName}`,
        language: lang,
        priority: res.pool === "kool1" ? 95 : res.pool === "kool6" ? 90 : 85,
        headers: res.headers,
      }),
    );
  }
  return streams;
}
