import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { PluginManifest, RepoIndex, RepoPluginEntry } from "vessel";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CORE_DIR = path.join(ROOT_DIR, "core");
const EXTRACTORS_DIR = path.join(ROOT_DIR, "extractors");
const PLUGINS_DIR = path.join(ROOT_DIR, "plugins");
const REPO_JSON_PATH = path.join(ROOT_DIR, "repo.json");
const DATA_M3U_PATH = path.join(ROOT_DIR, "data", "canli.m3u");

const REPO_RAW_BASE =
  "https://raw.githubusercontent.com/falsisdev/anthology-vessel/main";

const PLUGIN_ICON_MAP: Record<string, string> = {
  "anthology-tv": `${REPO_RAW_BASE}/assets/canli/default_tv.png`,
  "anthology-plus": `${REPO_RAW_BASE}/assets/logo_1_transparent.png`,
  "anthology-diziler": `${REPO_RAW_BASE}/assets/canli/now.png`,
  anizium: `${REPO_RAW_BASE}/assets/anizium.png`,
  animecix: "https://www.google.com/s2/favicons?domain=animecix.tv&sz=128",
  animeprax: "https://www.google.com/s2/favicons?domain=animeprax.com&sz=128",
  animom: `${REPO_RAW_BASE}/assets/logo_1_transparent.png`,
  anizm: "https://cdn.anizm.net/images/logo_128x128.png",
  asyaanimeleri: "https://www.google.com/s2/favicons?domain=asyaanimeleri.top&sz=128",
  ddizi: "https://www.google.com/s2/favicons?domain=ddizi.tel&sz=128",
  ddizibox: "https://ddizibox.click/apple-touch-icon.png",
  dizibak: `${REPO_RAW_BASE}/assets/logo_1_transparent.png`,
  diziboxizle: "https://www.google.com/s2/favicons?domain=diziboxizle.com&sz=128",
  dizimom: "https://www.google.com/s2/favicons?domain=ddizimom.icu&sz=128",
  dizipod: "https://www.google.com/s2/favicons?domain=dizipod.com&sz=128",
  diziwatch: "https://www.google.com/s2/favicons?domain=diziwatch.org&sz=128",
  diziyou: "https://www.google.com/s2/favicons?domain=diziyou.net&sz=128",
  filmmodu: "https://www.filmmodu.one/icon/192x192.png",
  hdfilmcehennemi: "https://www.google.com/s2/favicons?domain=hdfilmcehennemi.land&sz=128",
  hdfilmdelisi: "https://www.google.com/s2/favicons?domain=hdfilmdelisi1.com&sz=128",
  hdfilmizle: "https://www.google.com/s2/favicons?domain=hdfilmizle.ink&sz=128",
  kultfilmler: "https://www.google.com/s2/favicons?domain=kultfilmler.net&sz=128",
  liderfilmizle: "https://liderfilmizle.vip/icons/icon-192.png",
  puhutv: "https://www.google.com/s2/favicons?domain=puhutv.com&sz=128",
  seicode: "https://www.google.com/s2/favicons?domain=seicode.net&sz=128",
  setfilmizle: "https://www.google.com/s2/favicons?domain=setfilmizle.ltd&sz=128",
  sinemacx: "https://www.google.com/s2/favicons?domain=sinemacc.com&sz=128",
  sonanime: "https://www.google.com/s2/favicons?domain=sonanime.com&sz=128",
  trdiziizle: "https://www.google.com/s2/favicons?domain=trdiziizle.tv&sz=128",
  tvdiziler: "https://tvdiziler.tv/assets/v1/img/favicon.png",
  webteizle: "https://www.google.com/s2/favicons?domain=webteizle.info&sz=128",
  yabancidizi: "https://www.google.com/s2/favicons?domain=yabancidizi.news&sz=128",
  "youtube-dizifilm": "https://www.google.com/s2/favicons?domain=youtube.com&sz=128",
};

export interface RawChannelRecord {
  id: string;
  name: string;
  group: string;
  logo: string;
  tvgId?: string;
  lang: string;
  urls: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function parseExtInfAttr(line: string, attr: string): string {
  const re = new RegExp(`${attr}="([^"]*)"`, "i");
  return re.exec(line)?.[1]?.trim() ?? "";
}

function makeChannelId(name: string, tvgId: string): string {
  const seed = (tvgId || name)
    .toLowerCase()
    .replace(/\.tr$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return seed || "channel";
}

function generateTvChannelsData(): void {
  const tvPluginDir = path.join(PLUGINS_DIR, "anthology-tv");
  if (!fs.existsSync(DATA_M3U_PATH) || !fs.existsSync(tvPluginDir)) return;

  const raw = fs.readFileSync(DATA_M3U_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  const byKey = new Map<string, RawChannelRecord>();
  const orderedKeys: string[] = [];

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
    const tvgId = parseExtInfAttr(line, "tvg-id");
    const logo = parseExtInfAttr(line, "tvg-logo");
    const group = parseExtInfAttr(line, "group-title") || "Genel";
    const lang = parseExtInfAttr(line, "tvg-lang") || "tr";
    const backupUrl = parseExtInfAttr(line, "tvg-backup");

    const id = makeChannelId(tvgName, tvgId);
    const dedupeKey = `${group}::${id}`;

    let existing = byKey.get(dedupeKey);
    if (!existing) {
      existing = {
        id,
        name: title.replace(/\s+HD$/i, "").trim() || tvgName,
        group,
        logo,
        tvgId: tvgId || undefined,
        lang,
        urls: [],
      };
      byKey.set(dedupeKey, existing);
      orderedKeys.push(dedupeKey);
    }

    if (!existing.urls.includes(streamUrl)) existing.urls.push(streamUrl);
    if (backupUrl && !existing.urls.includes(backupUrl)) {
      existing.urls.push(backupUrl);
    }
  }

  const records = orderedKeys
    .map((k) => byKey.get(k))
    .filter((v): v is RawChannelRecord => Boolean(v));

  const outPath = path.join(tvPluginDir, "channels-data.ts");
  const content =
    "// Auto-generated from data/canli.m3u by scripts/sync-plugins.ts — do not edit manually.\n" +
    "export interface EmbeddedChannel {\n" +
    "  id: string;\n" +
    "  name: string;\n" +
    "  group: string;\n" +
    "  logo: string;\n" +
    "  tvgId?: string;\n" +
    "  lang: string;\n" +
    "  urls: string[];\n" +
    "}\n\n" +
    `export const EMBEDDED_CHANNELS: readonly EmbeddedChannel[] = ${JSON.stringify(records, null, 2)};\n`;

  if (!fs.existsSync(outPath) || fs.readFileSync(outPath, "utf8") !== content) {
    fs.writeFileSync(outPath, content, "utf8");
  }
}

interface ParsedImport {
  specifier: string;
  start: number;
  end: number;
}

function collectModuleImports(filePath: string, sourceText: string): ParsedImport[] {
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const imports: ParsedImport[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const mod = node.moduleSpecifier;
      if (mod && ts.isStringLiteral(mod)) {
        imports.push({
          specifier: mod.text,
          start: mod.getStart(sf) + 1,
          end: mod.getEnd() - 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return imports;
}

/**
 * Maps an import target inside plugins/<id>/shared/... back to canonical root core/ or extractors/ source.
 */
function canonicalSourceAbs(resolvedAbs: string, pluginDir: string): string {
  const sharedDir = path.join(pluginDir, "shared");
  const relToShared = path.relative(sharedDir, resolvedAbs);
  if (!relToShared.startsWith("..") && !path.isAbsolute(relToShared)) {
    const rootCandidate = path.resolve(ROOT_DIR, relToShared);
    if (
      !rootCandidate.startsWith(`${CORE_DIR}${path.sep}`) &&
      !rootCandidate.startsWith(`${EXTRACTORS_DIR}${path.sep}`)
    ) {
      throw new Error(
        `Shared import '${resolvedAbs}' must map inside core/ or extractors/`,
      );
    }
    return rootCandidate;
  }

  if (
    resolvedAbs.startsWith(`${CORE_DIR}${path.sep}`) ||
    resolvedAbs.startsWith(`${EXTRACTORS_DIR}${path.sep}`) ||
    resolvedAbs.startsWith(`${pluginDir}${path.sep}`)
  ) {
    return resolvedAbs;
  }

  throw new Error(
    `Import target '${resolvedAbs}' lies outside plugins/<id>/, core/, or extractors/`,
  );
}

function mapCanonicalToPluginRel(canonicalAbs: string, pluginDir: string): string {
  if (canonicalAbs.startsWith(`${pluginDir}${path.sep}`)) {
    return toPosix(path.relative(pluginDir, canonicalAbs));
  }
  const relToRoot = path.relative(ROOT_DIR, canonicalAbs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new Error(`Import target '${canonicalAbs}' lies outside repository root`);
  }
  return toPosix(path.join("shared", relToRoot));
}

function rewriteSourceImports(
  canonicalAbs: string,
  sourceText: string,
  pluginDir: string,
): { rewritten: string; dependencies: string[] } {
  const imports = collectModuleImports(canonicalAbs, sourceText);
  const currentRel = mapCanonicalToPluginRel(canonicalAbs, pluginDir);
  const currentDirRel = path.posix.dirname(currentRel);

  const dependencies: string[] = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  for (const imp of imports) {
    if (imp.specifier === "vessel") continue;
    if (!imp.specifier.startsWith("./") && !imp.specifier.startsWith("../")) {
      throw new Error(
        `${canonicalAbs}: disallowed bare module import '${imp.specifier}' (only 'vessel' allowed)`,
      );
    }

    const resolvedAbs = path.resolve(path.dirname(canonicalAbs), imp.specifier);
    const targetCanonical = canonicalSourceAbs(resolvedAbs, pluginDir);
    if (!fs.existsSync(targetCanonical)) {
      throw new Error(
        `${canonicalAbs}: missing import target '${imp.specifier}' -> ${targetCanonical}`,
      );
    }
    dependencies.push(targetCanonical);

    const targetRel = mapCanonicalToPluginRel(targetCanonical, pluginDir);
    let rewrittenSpec = path.posix.relative(currentDirRel, targetRel);
    if (!rewrittenSpec.startsWith("./") && !rewrittenSpec.startsWith("../")) {
      rewrittenSpec = `./${rewrittenSpec}`;
    }

    if (rewrittenSpec !== imp.specifier) {
      replacements.push({
        start: imp.start,
        end: imp.end,
        text: rewrittenSpec,
      });
    }
  }

  if (replacements.length === 0) {
    return { rewritten: sourceText, dependencies };
  }

  replacements.sort((a, b) => b.start - a.start);
  let output = sourceText;
  for (const r of replacements) {
    output = `${output.slice(0, r.start)}${r.text}${output.slice(r.end)}`;
  }
  return { rewritten: output, dependencies };
}

function cleanEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      cleanEmptyDirs(sub);
      if (fs.readdirSync(sub).length === 0) {
        fs.rmdirSync(sub);
      }
    }
  }
}

function listAllFiles(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAllFiles(full, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function syncOnePlugin(pluginDir: string): RepoPluginEntry {
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing manifest.json in ${pluginDir}`);
  }
  const rawManifestText = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(rawManifestText) as PluginManifest;
  const entryAbs = path.join(pluginDir, manifest.entry || "index.ts");
  if (!fs.existsSync(entryAbs)) {
    throw new Error(`Missing entry '${manifest.entry}' in ${pluginDir}`);
  }

  const visited = new Set<string>();
  const queue: string[] = [entryAbs];
  const emittedFiles = new Map<string, string>();

  while (queue.length > 0) {
    const fileAbs = queue.shift();
    if (!fileAbs || visited.has(fileAbs)) continue;
    visited.add(fileAbs);

    const text = fs.readFileSync(fileAbs, "utf8");
    const relOut = mapCanonicalToPluginRel(fileAbs, pluginDir);
    const { rewritten, dependencies } = rewriteSourceImports(
      fileAbs,
      text,
      pluginDir,
    );
    emittedFiles.set(relOut, rewritten);
    for (const dep of dependencies) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  const sharedDir = path.join(pluginDir, "shared");
  for (const existingSharedRel of listAllFiles(sharedDir)) {
    const pluginRel = toPosix(path.join("shared", existingSharedRel));
    if (!emittedFiles.has(pluginRel)) {
      fs.rmSync(path.join(sharedDir, existingSharedRel), { force: true });
    }
  }

  for (const [relPath, contents] of emittedFiles.entries()) {
    const dst = path.join(pluginDir, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst) || fs.readFileSync(dst, "utf8") !== contents) {
      fs.writeFileSync(dst, contents, "utf8");
    }
  }

  cleanEmptyDirs(sharedDir);
  if (fs.existsSync(sharedDir) && fs.readdirSync(sharedDir).length === 0) {
    fs.rmdirSync(sharedDir);
  }

  const extraFiles = Array.from(emittedFiles.keys())
    .filter((f) => f !== (manifest.entry || "index.ts"))
    .sort();

  const optionalIcon = path.join(pluginDir, "icon.png");
  const mappedIcon = PLUGIN_ICON_MAP[manifest.id];
  const fallbackIcon = `${REPO_RAW_BASE}/assets/logo_1_transparent.png`;
  const iconUrl = fs.existsSync(optionalIcon)
    ? `${REPO_RAW_BASE}/plugins/${manifest.id}/icon.png`
    : mappedIcon ?? manifest.icon?.trim() ?? fallbackIcon;

  const syncedManifest: PluginManifest = {
    ...manifest,
    icon: iconUrl,
    files: extraFiles.length > 0 ? extraFiles : undefined,
  };
  const nextManifestText = `${JSON.stringify(syncedManifest, null, 2)}\n`;
  if (rawManifestText !== nextManifestText) {
    fs.writeFileSync(manifestPath, nextManifestText, "utf8");
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    capabilities: manifest.capabilities,
    contentTypes: manifest.contentTypes,
    languages: manifest.languages,
    isAdult: manifest.isAdult ?? false,
    iconUrl: syncedManifest.icon,
    sourcePath: `${REPO_RAW_BASE}/plugins/${manifest.id}/manifest.json`,
    minCoreVersion: manifest.minCoreVersion,
  };
}

function pluginSortOrder(a: string, b: string): number {
  const rank = (id: string): number => {
    if (id === "anthology-tv") return 0;
    if (id === "anthology-plus") return 1;
    return 2;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

function main(): void {
  generateTvChannelsData();

  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  const pluginDirs = fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLUGINS_DIR, d.name, "manifest.json")))
    .map((d) => d.name)
    .sort(pluginSortOrder);

  const entries: RepoPluginEntry[] = [];
  for (const dirName of pluginDirs) {
    entries.push(syncOnePlugin(path.join(PLUGINS_DIR, dirName)));
  }

  const repoIndex: RepoIndex = {
    schemaVersion: 1,
    id: "anthology-vessel",
    name: "Anthology (Vessel)",
    description:
      "Vessel için doğrulanmış Türkçe Film, Dizi, Anime ve Canlı TV eklenti deposu",
    author: "falsisdev",
    website: "https://falsisdev.github.io/anthology/",
    iconUrl: `${REPO_RAW_BASE}/assets/logo_1_transparent.png`,
    pluginLists: [],
    plugins: entries,
  };

  fs.writeFileSync(
    REPO_JSON_PATH,
    `${JSON.stringify(repoIndex, null, 2)}\n`,
    "utf8",
  );
  console.log(`Synced ${entries.length} Vessel plugin(s) and updated repo.json.`);
}

main();
