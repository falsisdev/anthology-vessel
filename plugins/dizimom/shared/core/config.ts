import { http, storage } from "vessel";
import { DEFAULT_USER_AGENT, rethrowIfDomainBlocked } from "./http.ts";

export const REPO_RAW_BASE =
  "https://raw.githubusercontent.com/falsisdev/anthology-vessel/main";
export const REMOTE_CONFIG_URL = `${REPO_RAW_BASE}/config.json`;

const CONFIG_TTL_MS = 10 * 60 * 1000;
const STORAGE_CONFIG_TTL_MS = 30 * 60 * 1000;
const STORAGE_CONFIG_KEY = "__anthology_remote_cfg_v1";

interface StoredConfigSnapshot {
  at: number;
  data: Record<string, unknown>;
}

let cachedConfig: Record<string, unknown> | null = null;
let cachedAt = 0;
let inFlightConfig: Promise<Record<string, unknown>> | null = null;

export async function loadRemoteConfig(): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CONFIG_TTL_MS) {
    return cachedConfig;
  }
  if (inFlightConfig) {
    return inFlightConfig;
  }

  inFlightConfig = (async () => {
    let staleStored: Record<string, unknown> | null = null;
    try {
      const stored = await storage.get<StoredConfigSnapshot>(STORAGE_CONFIG_KEY);
      if (
        stored &&
        typeof stored === "object" &&
        stored.data &&
        typeof stored.data === "object" &&
        !Array.isArray(stored.data)
      ) {
        staleStored = stored.data;
        if (typeof stored.at === "number" && now - stored.at < STORAGE_CONFIG_TTL_MS) {
          cachedConfig = stored.data;
          cachedAt = now;
          return stored.data;
        }
      }
    } catch {
      // Storage unavailable or empty; continue with remote fetch.
    }

    try {
      const res = await http.get(REMOTE_CONFIG_URL, {
        timeoutMs: 1_500,
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "application/json",
        },
      });
      if (res.status >= 200 && res.status < 300) {
        const parsed = res.json<unknown>();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          cachedConfig = parsed as Record<string, unknown>;
          cachedAt = now;
          try {
            await storage.set(STORAGE_CONFIG_KEY, { at: now, data: cachedConfig });
          } catch {
            // Non-fatal if storage persistence is unavailable.
          }
          return cachedConfig;
        }
      }
    } catch (err) {
      rethrowIfDomainBlocked(err);
    }

    cachedConfig = cachedConfig ?? staleStored ?? {};
    cachedAt = now;
    return cachedConfig;
  })();

  try {
    return await inFlightConfig;
  } finally {
    inFlightConfig = null;
  }
}

export function getNestedValue(
  obj: Record<string, unknown>,
  dotPath: string,
): unknown {
  let current: unknown = obj;
  for (const segment of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export async function configString(
  dotPath: string,
  fallback: string,
): Promise<string> {
  const cfg = await loadRemoteConfig();
  const val = getNestedValue(cfg, dotPath);
  if (typeof val === "string" && val.trim().length > 0) {
    return val.trim();
  }
  return fallback;
}

export async function configStringArray(
  dotPath: string,
  fallback: string[],
): Promise<string[]> {
  const cfg = await loadRemoteConfig();
  const val = getNestedValue(cfg, dotPath);
  if (Array.isArray(val)) {
    const cleaned = val
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim().replace(/\/+$/, ""));
    if (cleaned.length > 0) return cleaned;
  }
  return fallback;
}

export async function configNumber(
  dotPath: string,
  fallback: number,
): Promise<number> {
  const cfg = await loadRemoteConfig();
  const val = getNestedValue(cfg, dotPath);
  if (typeof val === "number" && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === "string") {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Resolves a provider base URL in priority order:
 * 1. User-configured `settingsSchema` override (`mirrorUrl` or custom key)
 * 2. Remote `config.json` path
 * 3. Compile-time default
 */
export async function resolveBaseUrl(
  configDotPath: string,
  defaultUrl: string,
  settingKey = "mirrorUrl",
): Promise<string> {
  try {
    const userSetting = await storage.getSetting<string>(settingKey);
    if (typeof userSetting === "string" && /^https?:\/\//i.test(userSetting.trim())) {
      return userSetting.trim().replace(/\/+$/, "");
    }
  } catch {
    // Setting not configured or unavailable in standalone unit tests.
  }
  const configured = await configString(configDotPath, defaultUrl);
  return configured.replace(/\/+$/, "");
}

/**
 * Reads a boolean toggle setting with tolerance for serialized strings/numbers.
 */
export async function readToggleSetting(
  key: string,
  fallback = true,
): Promise<boolean> {
  try {
    const val = await storage.getSetting<boolean | string | number>(key);
    if (val === undefined || val === null) return fallback;
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    const norm = String(val).trim().toLowerCase();
    if (!norm) return fallback;
    if (norm === "false" || norm === "0" || norm === "off" || norm === "no") {
      return false;
    }
    if (norm === "true" || norm === "1" || norm === "on" || norm === "yes") {
      return true;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function clearConfigCache(): void {
  cachedConfig = null;
  cachedAt = 0;
  inFlightConfig = null;
}
