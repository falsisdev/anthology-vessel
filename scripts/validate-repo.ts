import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  ContentCategory,
  PluginCapability,
  PluginManifest,
  RepoIndex,
  SettingFieldType,
} from "vessel";

const ROOT = path.resolve(import.meta.dirname, "..");
const VALID_CAPABILITIES = new Set<PluginCapability>([
  "vod",
  "search",
  "live_tv",
  "subtitles",
  "extractor",
]);
const VALID_CONTENT_TYPES = new Set<ContentCategory>([
  "movie",
  "series",
  "anime",
  "live",
]);
const VALID_SETTING_TYPES = new Set<SettingFieldType>([
  "text",
  "secret",
  "toggle",
  "select",
]);

function checkAst(filePath: string, sourceText: string, pluginDir: string, errors: string[]): void {
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isEnumDeclaration(node)) {
      errors.push(`${filePath}: TypeScript 'enum' is disallowed by Vessel erasableSyntaxOnly`);
    }
    if (ts.isModuleDeclaration(node)) {
      errors.push(`${filePath}: TypeScript 'namespace' is disallowed by Vessel erasableSyntaxOnly`);
    }
    if (ts.isParameterPropertyDeclaration(node, node.parent)) {
      errors.push(`${filePath}: constructor parameter properties are disallowed by Vessel oxc`);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (spec !== "vessel") {
        if (!spec.startsWith("./") && !spec.startsWith("../")) {
          errors.push(`${filePath}: disallowed external import '${spec}'`);
        } else {
          const resolved = path.resolve(path.dirname(filePath), spec);
          const relToPlugin = path.relative(pluginDir, resolved);
          if (relToPlugin.startsWith("..") || path.isAbsolute(relToPlugin)) {
            errors.push(`${filePath}: import '${spec}' escapes plugin bundle root`);
          } else if (!fs.existsSync(resolved)) {
            errors.push(`${filePath}: broken relative import '${spec}'`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function domainCovered(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  for (const pattern of allowed) {
    const p = pattern.toLowerCase().trim();
    if (p === h) return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // .example.com
      const apex = p.slice(2);
      if (h === apex || h.endsWith(suffix)) return true;
    }
  }
  return false;
}

function main(): void {
  const errors: string[] = [];
  const repoPath = path.join(ROOT, "repo.json");
  if (!fs.existsSync(repoPath)) {
    throw new Error("repo.json does not exist. Run 'npm run sync' first.");
  }

  const repo = JSON.parse(fs.readFileSync(repoPath, "utf8")) as RepoIndex;
  if (repo.schemaVersion !== 1) {
    errors.push(`repo.json: schemaVersion must be 1 (got ${String(repo.schemaVersion)})`);
  }
  if (!repo.id || !repo.name || !Array.isArray(repo.plugins)) {
    errors.push("repo.json: missing required top-level fields");
  }

  const seenIds = new Set<string>();
  for (const entry of repo.plugins) {
    if (!/^[a-z0-9-]+$/.test(entry.id)) {
      errors.push(`repo.json: plugin id '${entry.id}' must be lowercase kebab-case`);
    }
    if (seenIds.has(entry.id)) {
      errors.push(`repo.json: duplicate plugin id '${entry.id}'`);
    }
    seenIds.add(entry.id);

    if (!entry.sourcePath) {
      errors.push(`repo.json: plugin '${entry.id}' missing sourcePath`);
      continue;
    }
    if (entry.sourcePath.endsWith("manifest.json")) {
      errors.push(
        `repo.json: plugin '${entry.id}' sourcePath must be directory ('plugins/<id>'), not manifest.json`,
      );
    }

    const pluginDir = path.join(ROOT, entry.sourcePath);
    const manifestPath = path.join(pluginDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      errors.push(`plugins/${entry.id}: missing manifest.json`);
      continue;
    }

    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as PluginManifest;
    if (manifest.schemaVersion !== 1) {
      errors.push(`${entry.id}/manifest.json: schemaVersion must be 1`);
    }
    if (manifest.id !== entry.id) {
      errors.push(`${entry.id}/manifest.json: id mismatch with repo.json`);
    }
    if (manifest.version !== entry.version) {
      errors.push(`${entry.id}/manifest.json: version mismatch with repo.json`);
    }
    if (manifest.allowAnyHttps === true) {
      errors.push(`${entry.id}/manifest.json: allowAnyHttps must remain false/omitted`);
    }
    if (!Array.isArray(manifest.domains) || manifest.domains.length === 0) {
      errors.push(`${entry.id}/manifest.json: domains must be a non-empty allowlist`);
    } else {
      for (const dom of manifest.domains) {
        if (dom.includes("://") || dom.includes("/")) {
          errors.push(`${entry.id}/manifest.json: invalid domain pattern '${dom}'`);
        }
      }
    }
    for (const cap of manifest.capabilities ?? []) {
      if (!VALID_CAPABILITIES.has(cap)) {
        errors.push(`${entry.id}/manifest.json: invalid capability '${cap}'`);
      }
    }
    for (const ct of manifest.contentTypes ?? []) {
      if (!VALID_CONTENT_TYPES.has(ct)) {
        errors.push(`${entry.id}/manifest.json: invalid contentType '${ct}'`);
      }
    }
    for (const field of manifest.settingsSchema ?? []) {
      if (!VALID_SETTING_TYPES.has(field.type)) {
        errors.push(
          `${entry.id}/manifest.json: invalid setting field type '${String(field.type)}'`,
        );
      }
    }

    const entryPath = path.join(pluginDir, manifest.entry);
    if (!fs.existsSync(entryPath)) {
      errors.push(`${entry.id}/manifest.json: entry '${manifest.entry}' not found`);
    }
    for (const relFile of manifest.files ?? []) {
      if (!fs.existsSync(path.join(pluginDir, relFile))) {
        errors.push(`${entry.id}/manifest.json: listed file '${relFile}' not found`);
      }
    }

    const tsFiles = collectTsFiles(pluginDir);
    let usesTmdb = false;
    let usesRemoteConfig = false;

    for (const tf of tsFiles) {
      const code = fs.readFileSync(tf, "utf8");
      checkAst(tf, code, pluginDir, errors);
      if (code.includes("api.themoviedb.org")) usesTmdb = true;
      if (code.includes("raw.githubusercontent.com")) usesRemoteConfig = true;
    }

    if (usesTmdb && !domainCovered("api.themoviedb.org", manifest.domains ?? [])) {
      errors.push(`${entry.id}: imports TMDB helper without 'api.themoviedb.org' in domains`);
    }
    if (
      usesRemoteConfig &&
      !domainCovered("raw.githubusercontent.com", manifest.domains ?? [])
    ) {
      errors.push(
        `${entry.id}: imports remote config helper without 'raw.githubusercontent.com' in domains`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`Validation failed with ${errors.length} error(s):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${repo.plugins.length} plugin(s) in repo.json cleanly.`);
}

main();
