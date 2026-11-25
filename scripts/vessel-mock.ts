import nodeCrypto from "node:crypto";
import { registerHooks } from "node:module";
import vm from "node:vm";
import type {
  EvalEnvOptions,
  HtmlDocument,
  HtmlElement,
  HttpFullRequestOptions,
  HttpRequestOptions,
  HttpResponse,
  PluginManifest,
  VesselPlugin,
} from "vessel";

interface DomNode {
  kind: "element" | "text";
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: DomNode[];
  parent: DomNode | null;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function decodeEntitiesBasic(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe =
    /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw)) !== null) {
    const key = (m[1] ?? "").toLowerCase();
    if (!key) continue;
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[key] = decodeEntitiesBasic(val);
  }
  return attrs;
}

function parseHtmlTree(rawHtml: string): DomNode {
  const root: DomNode = {
    kind: "element",
    tag: "#document",
    attrs: {},
    text: "",
    children: [],
    parent: null,
  };
  const stack: DomNode[] = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9:-]+)\s*>|<([a-zA-Z0-9:-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string): void => {
    if (!chunk) return;
    const current = stack[stack.length - 1] ?? root;
    current.children.push({
      kind: "text",
      tag: "#text",
      attrs: {},
      text: decodeEntitiesBasic(chunk),
      children: [],
      parent: current,
    });
  };

  while ((match = tokenRe.exec(rawHtml)) !== null) {
    if (match.index > lastIdx) {
      pushText(rawHtml.slice(lastIdx, match.index));
    }
    lastIdx = tokenRe.lastIndex;
    const full = match[0];
    if (full.startsWith("<!--")) continue;

    if (match[1]) {
      const closeTag = match[1].toLowerCase();
      for (let idx = stack.length - 1; idx >= 1; idx--) {
        if (stack[idx]?.tag === closeTag) {
          stack.length = idx;
          break;
        }
      }
      continue;
    }

    const openTag = (match[2] ?? "").toLowerCase();
    const rawAttrs = match[3] ?? "";
    const selfClosing = Boolean(match[4]) || VOID_TAGS.has(openTag);
    const parent = stack[stack.length - 1] ?? root;
    const elem: DomNode = {
      kind: "element",
      tag: openTag,
      attrs: parseAttributes(rawAttrs),
      text: "",
      children: [],
      parent,
    };
    parent.children.push(elem);

    if (!selfClosing) {
      if (openTag === "script" || openTag === "style") {
        const closeMarker = `</${openTag}`;
        const closePos = rawHtml.toLowerCase().indexOf(closeMarker, lastIdx);
        if (closePos >= 0) {
          elem.children.push({
            kind: "text",
            tag: "#text",
            attrs: {},
            text: rawHtml.slice(lastIdx, closePos),
            children: [],
            parent: elem,
          });
          const endGt = rawHtml.indexOf(">", closePos);
          lastIdx = endGt >= 0 ? endGt + 1 : rawHtml.length;
          tokenRe.lastIndex = lastIdx;
        }
      } else {
        stack.push(elem);
      }
    }
  }

  if (lastIdx < rawHtml.length) {
    pushText(rawHtml.slice(lastIdx));
  }
  return root;
}

function collectText(node: DomNode): string {
  if (node.kind === "text") return node.text;
  return node.children.map(collectText).join("");
}

function serializeOuter(node: DomNode): string {
  if (node.kind === "text") return node.text;
  if (node.tag === "#document") {
    return node.children.map(serializeOuter).join("");
  }
  const attrParts = Object.entries(node.attrs).map(([k, v]) =>
    `${k}="${v.replace(/"/g, "&quot;")}"`,
  );
  const open = attrParts.length > 0 ? `<${node.tag} ${attrParts.join(" ")}>` : `<${node.tag}>`;
  if (VOID_TAGS.has(node.tag)) return open;
  const inner = node.children.map(serializeOuter).join("");
  return `${open}${inner}</${node.tag}>`;
}

function splitTopLevelCommas(selector: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let bracket = 0;
  let quote = "";
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote && selector[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "[") {
      bracket++;
      buf += ch;
    } else if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      buf += ch;
    } else if (ch === "," && bracket === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function matchesSimpleSelector(node: DomNode, simple: string): boolean {
  if (node.kind !== "element" || node.tag === "#document") return false;
  let rest = simple.trim();
  if (!rest) return false;

  const tagMatch = /^(\*|[a-zA-Z0-9_-]+)/.exec(rest);
  if (tagMatch) {
    const tag = tagMatch[1]!.toLowerCase();
    if (tag !== "*" && node.tag !== tag) return false;
    rest = rest.slice(tagMatch[0].length);
  }

  while (rest.length > 0) {
    if (rest.startsWith("#")) {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return false;
      if ((node.attrs["id"] ?? "") !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith(".")) {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return false;
      const classes = (node.attrs["class"] ?? "").split(/\s+/).filter(Boolean);
      if (!classes.includes(m[1]!)) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) return false;
      const expr = rest.slice(1, end).trim();
      rest = rest.slice(end + 1);
      const opMatch = /^([a-zA-Z0-9_:-]+)\s*([*^$|~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))$/.exec(expr);
      if (opMatch) {
        const attrName = opMatch[1]!.toLowerCase();
        const op = opMatch[2]!;
        const expected = opMatch[3] ?? opMatch[4] ?? (opMatch[5] ?? "").trim();
        const actual = node.attrs[attrName];
        if (actual === undefined) return false;
        if (op === "=" && actual !== expected) return false;
        if (op === "*=" && !actual.includes(expected)) return false;
        if (op === "^=" && !actual.startsWith(expected)) return false;
        if (op === "$=" && !actual.endsWith(expected)) return false;
        if (op === "~=" && !actual.split(/\s+/).includes(expected)) return false;
      } else {
        const attrOnly = expr.toLowerCase();
        if (node.attrs[attrOnly] === undefined) return false;
      }
    } else if (rest.startsWith(":")) {
      const pm = /^:([a-zA-Z0-9_-]+)(?:\(([^)]+)\))?/.exec(rest);
      if (!pm) return false;
      const pseudo = pm[1]!.toLowerCase();
      const arg = pm[2]?.trim() ?? "";
      rest = rest.slice(pm[0].length);
      const siblings = (node.parent?.children ?? []).filter((c) => c.kind === "element");
      const pos = siblings.indexOf(node) + 1;
      if (pseudo === "first-child" && pos !== 1) return false;
      if (pseudo === "last-child" && pos !== siblings.length) return false;
      if (pseudo === "nth-child" && Number(arg) !== pos) return false;
    } else {
      return false;
    }
  }
  return true;
}

interface SelectorToken {
  combinator: "descendant" | "child" | "adjacent";
  simple: string;
}

function tokenizeComplexSelector(complex: string): SelectorToken[] {
  const tokens: SelectorToken[] = [];
  let i = 0;
  let nextComb: SelectorToken["combinator"] = "descendant";
  const src = complex.trim();

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) break;
    if (src[i] === ">") {
      nextComb = "child";
      i++;
      continue;
    }
    if (src[i] === "+") {
      nextComb = "adjacent";
      i++;
      continue;
    }
    let buf = "";
    let bracket = 0;
    let quote = "";
    while (i < src.length) {
      const ch = src[i]!;
      if (quote) {
        buf += ch;
        if (ch === quote && src[i - 1] !== "\\") quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        buf += ch;
      } else if (ch === "[") {
        bracket++;
        buf += ch;
      } else if (ch === "]") {
        bracket = Math.max(0, bracket - 1);
        buf += ch;
      } else if (bracket === 0 && (/\s/.test(ch) || ch === ">" || ch === "+")) {
        break;
      } else {
        buf += ch;
      }
      i++;
    }
    if (buf) {
      tokens.push({ combinator: nextComb, simple: buf });
      nextComb = "descendant";
    }
  }
  return tokens;
}

function matchesComplexSelector(node: DomNode, tokens: SelectorToken[]): boolean {
  if (tokens.length === 0 || node.kind !== "element" || node.tag === "#document") {
    return false;
  }
  const last = tokens[tokens.length - 1]!;
  if (!matchesSimpleSelector(node, last.simple)) return false;
  if (tokens.length === 1) return true;

  const prefix = tokens.slice(0, -1);
  if (last.combinator === "child") {
    return node.parent ? matchesComplexSelector(node.parent, prefix) : false;
  }
  if (last.combinator === "adjacent") {
    const siblings = (node.parent?.children ?? []).filter((c) => c.kind === "element");
    const idx = siblings.indexOf(node);
    return idx > 0 ? matchesComplexSelector(siblings[idx - 1]!, prefix) : false;
  }

  let cur = node.parent;
  while (cur && cur.tag !== "#document") {
    if (matchesComplexSelector(cur, prefix)) return true;
    cur = cur.parent;
  }
  return false;
}

function queryElements(root: DomNode, css: string): DomNode[] {
  const groups = splitTopLevelCommas(css).map(tokenizeComplexSelector);
  const found: DomNode[] = [];
  const walk = (node: DomNode): void => {
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (groups.some((g) => matchesComplexSelector(child, g))) {
        found.push(child);
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

function wrapElement(node: DomNode): HtmlElement {
  return {
    tagName: () => node.tag,
    text: () => collectText(node).replace(/\s+/g, " ").trim(),
    ownText: () =>
      node.children
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    html: () => node.children.map(serializeOuter).join(""),
    outerHtml: () => serializeOuter(node),
    attr: (name: string) => {
      const val = node.attrs[name.toLowerCase()];
      return val === undefined ? null : val;
    },
    attrs: () => ({ ...node.attrs }),
    hasClass: (name: string) =>
      (node.attrs["class"] ?? "").split(/\s+/).filter(Boolean).includes(name),
    matches: (css: string) =>
      splitTopLevelCommas(css)
        .map(tokenizeComplexSelector)
        .some((g) => matchesComplexSelector(node, g)),
    select: (css: string) => queryElements(node, css).map(wrapElement),
    selectOne: (css: string) => {
      const first = queryElements(node, css)[0];
      return first ? wrapElement(first) : null;
    },
    children: () =>
      node.children.filter((c) => c.kind === "element").map(wrapElement),
    parent: () =>
      node.parent && node.parent.tag !== "#document"
        ? wrapElement(node.parent)
        : null,
    next: () => {
      const siblings = (node.parent?.children ?? []).filter(
        (c) => c.kind === "element",
      );
      const idx = siblings.indexOf(node);
      return idx >= 0 && siblings[idx + 1] ? wrapElement(siblings[idx + 1]!) : null;
    },
    prev: () => {
      const siblings = (node.parent?.children ?? []).filter(
        (c) => c.kind === "element",
      );
      const idx = siblings.indexOf(node);
      return idx > 0 ? wrapElement(siblings[idx - 1]!) : null;
    },
  };
}

function isDomainAllowed(urlStr: string, manifest: PluginManifest): boolean {
  if (manifest.allowAnyHttps) return true;
  const parsed = new URL(urlStr);
  const host = parsed.hostname.toLowerCase();
  for (const pattern of manifest.domains ?? []) {
    const p = pattern.toLowerCase().trim();
    if (p === host) return true;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1);
      const apex = p.slice(2);
      if (host === apex || host.endsWith(suffix)) return true;
    }
  }
  return false;
}

function unpackDeanEdwards(packed: string): string {
  const m =
    /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\(['"]\|['"]\)/.exec(
      packed,
    );
  if (!m) return packed;
  const payload = m[2]!.replace(/\\'/g, "'").replace(/\\"/g, '"');
  const radix = Number(m[3]);
  let count = Number(m[4]);
  const symtab = m[6]!.split("|");

  const encode = (c: number): string => {
    const prefix = c < radix ? "" : encode(Math.floor(c / radix));
    const rem = c % radix;
    return prefix + (rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36));
  };

  const dict: Record<string, string> = {};
  while (count--) {
    const token = encode(count);
    dict[token] = symtab[count] || token;
  }
  return payload.replace(/\b\w+\b/g, (word) => dict[word] ?? word);
}

interface ActiveContext {
  manifest: PluginManifest;
  kv: Map<string, unknown>;
  settings: Map<string, unknown>;
}

let activeContext: ActiveContext = {
  manifest: {
    schemaVersion: 1,
    id: "mock",
    name: "Mock",
    version: "1.0.0",
    entry: "index.ts",
    capabilities: ["vod"],
    allowAnyHttps: true,
    domains: [],
  },
  kv: new Map(),
  settings: new Map(),
};

function makeVesselApi() {
  const httpRequest = async (
    opts: HttpFullRequestOptions,
  ): Promise<HttpResponse> => {
    if (!isDomainAllowed(opts.url, activeContext.manifest)) {
      const host = new URL(opts.url).hostname;
      throw new Error(
        `[VesselDomainBlockedError]: domain '${host}' is not listed in ${activeContext.manifest.id} manifest domains`,
      );
    }

    const reqHeaders = new Headers(opts.headers ?? {});
    let body: string | undefined;
    if (typeof opts.body === "string") {
      body = opts.body;
    } else if (opts.body && typeof opts.body === "object") {
      body = JSON.stringify(opts.body);
      if (!reqHeaders.has("Content-Type")) {
        reqHeaders.set("Content-Type", "application/json");
      }
    }

    const res = await fetch(opts.url, {
      method: opts.method,
      headers: reqHeaders,
      body,
      redirect: opts.followRedirects === false ? "manual" : "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });

    const buf = new Uint8Array(await res.arrayBuffer());
    const textStr = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const headersObj: Record<string, string> = {};
    res.headers.forEach((val, key) => {
      headersObj[key] = val;
    });

    return {
      status: res.status,
      url: res.url || opts.url,
      headers: headersObj,
      text: () => textStr,
      json: <T = unknown>() => JSON.parse(textStr) as T,
      bytes: () => buf,
    };
  };

  return {
    http: {
      get: (url: string, opts?: HttpRequestOptions) =>
        httpRequest({ method: "GET", url, ...(opts ?? {}) }),
      post: (
        url: string,
        body?: string | Record<string, unknown> | null,
        opts?: HttpRequestOptions,
      ) =>
        httpRequest({
          method: "POST",
          url,
          body: body ?? undefined,
          ...(opts ?? {}),
        }),
      request: httpRequest,
    },
    html: {
      parse: (rawHtml: string): HtmlDocument => {
        const root = parseHtmlTree(rawHtml);
        return {
          html: () => serializeOuter(root),
          select: (css: string) => queryElements(root, css).map(wrapElement),
          selectOne: (css: string) => {
            const first = queryElements(root, css)[0];
            return first ? wrapElement(first) : null;
          },
        };
      },
    },
    crypto: {
      base64Encode: (input: string | Uint8Array) =>
        Buffer.from(input).toString("base64"),
      base64Decode: (b64: string) =>
        Buffer.from(b64, "base64").toString("binary"),
      base64DecodeBytes: (b64: string) =>
        new Uint8Array(Buffer.from(b64, "base64")),
      hexEncode: (input: string | Uint8Array) =>
        Buffer.from(input).toString("hex"),
      hexDecode: (hex: string) => new Uint8Array(Buffer.from(hex, "hex")),
      md5: (input: string) =>
        nodeCrypto.createHash("md5").update(input, "utf8").digest("hex"),
      sha1: (input: string) =>
        nodeCrypto.createHash("sha1").update(input, "utf8").digest("hex"),
      sha256: (input: string) =>
        nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex"),
      hmacSha256: (key: string, data: string) =>
        nodeCrypto.createHmac("sha256", key).update(data, "utf8").digest("hex"),
      aesEncrypt: (
        plain: string,
        key: string,
        iv = "",
        mode: "cbc" | "ecb" | "gcm" = "cbc",
      ) => {
        const kBuf = Buffer.from(key, "utf8");
        const bits = kBuf.length <= 16 ? 128 : kBuf.length <= 24 ? 192 : 256;
        const algo = `aes-${bits}-${mode}`;
        const cipher =
          mode === "ecb"
            ? nodeCrypto.createCipheriv(algo, kBuf, null)
            : nodeCrypto.createCipheriv(algo, kBuf, Buffer.from(iv, "utf8"));
        return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString(
          "base64",
        );
      },
      aesDecrypt: (
        cipherBase64: string,
        key: string,
        iv = "",
        mode: "cbc" | "ecb" | "gcm" = "cbc",
      ) => {
        const kBuf = Buffer.from(key, "utf8");
        const bits = kBuf.length <= 16 ? 128 : kBuf.length <= 24 ? 192 : 256;
        const algo = `aes-${bits}-${mode}`;
        const decipher =
          mode === "ecb"
            ? nodeCrypto.createDecipheriv(algo, kBuf, null)
            : nodeCrypto.createDecipheriv(algo, kBuf, Buffer.from(iv, "utf8"));
        return Buffer.concat([
          decipher.update(Buffer.from(cipherBase64, "base64")),
          decipher.final(),
        ]).toString("utf8");
      },
      rc4: (data: string, key: string) => {
        const s = new Uint8Array(256);
        for (let i = 0; i < 256; i++) s[i] = i;
        let j = 0;
        for (let i = 0; i < 256; i++) {
          j = (j + (s[i] ?? 0) + key.charCodeAt(i % key.length)) & 255;
          const tmp = s[i]!;
          s[i] = s[j]!;
          s[j] = tmp;
        }
        let i = 0;
        j = 0;
        let out = "";
        for (let k = 0; k < data.length; k++) {
          i = (i + 1) & 255;
          j = (j + (s[i] ?? 0)) & 255;
          const tmp = s[i]!;
          s[i] = s[j]!;
          s[j] = tmp;
          const rnd = s[((s[i] ?? 0) + (s[j] ?? 0)) & 255] ?? 0;
          out += String.fromCharCode(data.charCodeAt(k) ^ rnd);
        }
        return out;
      },
    },
    storage: {
      get: async <T = unknown>(key: string) =>
        (activeContext.kv.get(key) as T | undefined) ?? null,
      set: async (key: string, value: unknown) => {
        activeContext.kv.set(key, value);
      },
      remove: async (key: string) => {
        activeContext.kv.delete(key);
      },
      getSetting: async <T = unknown>(key: string) => {
        if (activeContext.settings.has(key)) {
          return activeContext.settings.get(key) as T;
        }
        const schemaItem = activeContext.manifest.settingsSchema?.find(
          (f) => f.key === key,
        );
        return (schemaItem?.default as T | undefined) ?? null;
      },
    },
    unpack: unpackDeanEdwards,
    evalWithEnv: async <T = unknown>(
      script: string,
      env?: EvalEnvOptions,
    ): Promise<T> => {
      const targetUrl = env?.url ?? "https://localhost/";
      const u = new URL(targetUrl);
      const locationObj = {
        href: u.href,
        origin: u.origin,
        protocol: u.protocol,
        host: u.host,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
      };
      const cookieStr = env?.cookies
        ? Object.entries(env.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ")
        : "";
      const sandbox: Record<string, unknown> = {
        location: locationObj,
        navigator: {
          userAgent:
            env?.userAgent ??
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        document: {
          location: locationObj,
          cookie: cookieStr,
          referrer: u.origin,
        },
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
        URL,
        URLSearchParams,
      };
      sandbox["window"] = sandbox;
      sandbox["self"] = sandbox;
      sandbox["globalThis"] = sandbox;
      const wrapped = `(function(){\n${script}\n})()`;
      return vm.runInNewContext(wrapped, sandbox, { timeout: 1000 }) as T;
    },
    definePlugin: <T extends VesselPlugin>(plugin: T): T => plugin,
  };
}

let hooksRegistered = false;
const vesselApi = makeVesselApi();

export function installVesselMockHooks(): void {
  (globalThis as Record<string, unknown>)["vessel"] = vesselApi;
  if (hooksRegistered) return;
  hooksRegistered = true;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "vessel") {
        return { url: "vessel:sdk", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === "vessel:sdk") {
        return {
          format: "module",
          source: [
            "const v = globalThis.vessel;",
            "export const http = v.http;",
            "export const html = v.html;",
            "export const crypto = v.crypto;",
            "export const storage = v.storage;",
            "export const unpack = v.unpack;",
            "export const evalWithEnv = v.evalWithEnv;",
            "export const definePlugin = v.definePlugin;",
          ].join("\n"),
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
}

export function setActivePluginContext(
  manifest: PluginManifest,
  settingsOverrides: Record<string, unknown> = {},
): void {
  const settings = new Map<string, unknown>();
  for (const field of manifest.settingsSchema ?? []) {
    if (field.default !== undefined) {
      settings.set(field.key, field.default);
    }
  }
  for (const [k, v] of Object.entries(settingsOverrides)) {
    settings.set(k, v);
  }
  activeContext = {
    manifest,
    kv: new Map(),
    settings,
  };
}
