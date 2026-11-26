import type { StreamCandidate } from "vessel";
import type { ResolvedTmdbIdentity } from "../tmdb.ts";

/**
 * Anthology Live VOD sunucusu kaldırıldığı için doğrudan yerel Vixolity akışları kullanılır.
 * Geriye dönük uyumluluk için boş dizi döner.
 */
export async function resolveGoVodByIdentity(_opts: {
  identity: ResolvedTmdbIdentity;
  season?: number;
  episode?: number;
  customBaseUrl?: string;
}): Promise<StreamCandidate[]> {
  return [];
}
