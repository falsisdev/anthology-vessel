import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginManifest, RepoIndex, VesselPlugin } from "vessel";
import {
  installVesselMockHooks,
  setActivePluginContext,
} from "./vessel-mock.ts";

installVesselMockHooks();

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const REPO_JSON_PATH = path.join(ROOT_DIR, "repo.json");
const PLUGINS_DIR = path.join(ROOT_DIR, "plugins");

interface SmokeOutcome {
  id: string;
  homeSections: number;
  homeItems: number;
  searchItems: number;
  detailsTitle?: string;
  streamsCount: number;
  status: "PASS" | "UPSTREAM_BLOCKED" | "EMPTY" | "FAIL";
  note?: string;
}

const SEARCH_QUERIES: Record<string, string> = {
  "anthology-tv": "TRT 1",
  "anthology-plus": "Inception",
  animecix: "Death Note",
  anizium: "One Punch Man",
  asyaanimeleri: "Death Note",
  anizm: "One Punch Man",
  animom: "Naruto",
  animeprax: "Naruto",
  seicode: "Solo Leveling",
  sonanime: "Naruto",
  "youtube-dizifilm": "Gibi",
  trdiziizle: "Kızılcık",
  tvdiziler: "Kızılcık",
  ddizi: "Kızılcık Şerbeti",
  puhutv: "Şahsiyet",
  "anthology-diziler": "Yargı",
};

async function testOnePlugin(id: string): Promise<SmokeOutcome> {
  const pluginDir = path.join(PLUGINS_DIR, id);
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      id,
      homeSections: 0,
      homeItems: 0,
      searchItems: 0,
      streamsCount: 0,
      status: "FAIL",
      note: "Missing manifest.json",
    };
  }

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as PluginManifest;
  setActivePluginContext(manifest);

  const entryUrl = pathToFileURL(path.join(pluginDir, manifest.entry)).href;
  const mod = (await import(`${entryUrl}?t=${Date.now()}`)) as {
    default?: VesselPlugin;
  };
  const plugin = mod.default;
  if (!plugin || typeof plugin.getStreams !== "function") {
    return {
      id,
      homeSections: 0,
      homeItems: 0,
      searchItems: 0,
      streamsCount: 0,
      status: "FAIL",
      note: "Missing default export implementing VesselPlugin",
    };
  }

  try {
    const feed = plugin.getHomeFeed ? await plugin.getHomeFeed(null) : { sections: [] };
    const homeSections = feed.sections.length;
    const homeItems = feed.sections.reduce((acc, s) => acc + s.items.length, 0);

    for (const sec of feed.sections) {
      for (const item of sec.items) {
        if (item.type !== "movie" && item.type !== "series" && item.type !== "live") {
          throw new Error(`Invalid MediaType '${item.type}' on ${item.title}`);
        }
      }
    }

    const query = SEARCH_QUERIES[id] ?? "Matrix";
    const searchPage = plugin.search
      ? await plugin.search(query, {}, 1)
      : { items: [], hasMore: false };
    const searchItems = searchPage.items.length;

    const sampleItem =
      searchPage.items[0] ?? feed.sections[0]?.items[0];
    let detailsTitle: string | undefined;
    let streamsCount = 0;

    if (sampleItem && plugin.getDetails) {
      const details = await plugin.getDetails(sampleItem.nativeId);
      detailsTitle = details.title;
      let firstEp = details.episodes[0];
      if (!firstEp && details.seasons?.[0] && plugin.getSeasonEpisodes) {
        const seasonEps = await plugin.getSeasonEpisodes(
          details.nativeId,
          details.seasons[0].id,
        );
        firstEp = seasonEps[0];
      }
      if (firstEp) {
        const res = await plugin.getStreams(firstEp.streamId);
        streamsCount = res.streams.length;
      }
    }

    const status =
      streamsCount > 0
        ? "PASS"
        : homeItems > 0 || searchItems > 0
          ? "EMPTY"
          : "UPSTREAM_BLOCKED";

    return {
      id,
      homeSections,
      homeItems,
      searchItems,
      detailsTitle,
      streamsCount,
      status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id,
      homeSections: 0,
      homeItems: 0,
      searchItems: 0,
      streamsCount: 0,
      status: msg.includes("[VesselDomainBlockedError]") ? "FAIL" : "FAIL",
      note: msg,
    };
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(REPO_JSON_PATH)) {
    console.error("repo.json missing. Run 'npm run sync' first.");
    process.exit(1);
  }
  const repo = JSON.parse(fs.readFileSync(REPO_JSON_PATH, "utf8")) as RepoIndex;
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const filter = new Set(args);
  const targets =
    filter.size > 0
      ? repo.plugins.filter((p) => filter.has(p.id))
      : repo.plugins;

  if (targets.length === 0) {
    console.log("No plugins matched filter (or repository has 0 synced plugins yet).");
    return;
  }

  let failed = 0;
  for (const target of targets) {
    const res = await testOnePlugin(target.id);
    if (res.status === "FAIL") failed += 1;
    console.log(
      `[${res.status.padEnd(16)}] ${res.id.padEnd(24)} home=${res.homeSections}s/${res.homeItems}i search=${res.searchItems} streams=${res.streamsCount}${res.detailsTitle ? ` title="${res.detailsTitle}"` : ""}${res.note ? ` (${res.note})` : ""}`,
    );
  }

  if (failed > 0) {
    process.exit(1);
  }
}

await main();
