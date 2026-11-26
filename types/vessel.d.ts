declare module "vessel" {
  export type PluginCapability = "vod" | "search" | "live_tv" | "subtitles" | "extractor";
  export type ContentCategory = "movie" | "series" | "anime" | "live";
  export type MediaType = "movie" | "series" | "live";
  export type ContentRating = "sfw" | "nsfw";
  export type EpisodeTag = "sub" | "dub" | "raw";
  export type RelationKind = "sequel" | "prequel" | "side_story" | "spin_off" | "related";
  export type HomeSectionLayout = "poster" | "landscape";

  export type StreamKind =
    | "hls"
    | "dash"
    | "mpeg_ts"
    | "mp4"
    | "mkv"
    | "webm"
    | "auto"
    | "embed";

  export type AudioType = "sub" | "dub" | "original";

  export type StreamFlag =
    | "subtitled"
    | "dubbed"
    | "multi_audio"
    | "hdr"
    | "direct"
    | "requires_proxy";

  export type SubtitleFormat = "srt" | "ass" | "ssa" | "vtt";

  export type SkipSegmentType = "intro" | "recap" | "credits" | "preview";

  export type SettingFieldType = "text" | "secret" | "toggle" | "select";

  export interface SettingSelectOption {
    label: string;
    value: string;
  }

  export interface PluginSettingField {
    key: string;
    label: string;
    type: SettingFieldType;
    default?: boolean | string;
    required?: boolean;
    placeholder?: string;
    options?: SettingSelectOption[];
  }

  export interface PluginManifest {
    schemaVersion: 1;
    id: string;
    name: string;
    version: string;
    author?: string;
    description?: string;
    entry: string;
    icon?: string;
    minCoreVersion?: string;
    capabilities: PluginCapability[];
    contentTypes?: ContentCategory[];
    languages?: string[];
    domains?: string[];
    allowAnyHttps?: boolean;
    isAdult?: boolean;
    files?: string[];
    settingsSchema?: PluginSettingField[];
  }

  export interface RepoPluginEntry {
    id: string;
    name: string;
    version: string;
    description?: string;
    capabilities: PluginCapability[];
    contentTypes?: ContentCategory[];
    languages?: string[];
    isAdult?: boolean;
    iconUrl?: string;
    downloadUrl?: string;
    sourcePath?: string;
    sha256?: string;
    minCoreVersion?: string;
  }

  export interface RepoIndex {
    schemaVersion: 1;
    id: string;
    name: string;
    description?: string;
    author?: string;
    website?: string;
    iconUrl?: string;
    pluginLists: string[];
    plugins: RepoPluginEntry[];
  }

  export interface ExternalIds {
    tmdb?: number;
    imdb?: string;
    tvdb?: number;
    anilist?: number;
    kitsu?: number;
    mal?: number;
    simkl?: number;
  }

  export interface MediaSummary {
    nativeId: string;
    pluginId?: string;
    type: MediaType;
    isAnime?: boolean;
    title: string;
    year?: number;
    poster?: string;
    rating?: number;
  }

  export interface SeasonSummary {
    id: string;
    season: number;
    title?: string;
    episodeCount?: number;
    poster?: string;
  }

  export interface MediaRelation {
    kind: RelationKind;
    nativeId: string;
    title: string;
    type: MediaType;
    isAnime?: boolean;
    poster?: string;
  }

  export interface Episode {
    streamId: string;
    season: number;
    episode: number;
    absoluteEpisode?: number;
    title?: string;
    overview?: string;
    thumbnail?: string;
    airDate?: string;
    tags?: EpisodeTag[];
  }

  export interface MediaDetail {
    nativeId: string;
    pluginId?: string;
    type: MediaType;
    isAnime?: boolean;
    title: string;
    originalTitle?: string;
    year?: number;
    synopsis?: string;
    poster?: string;
    backdrop?: string;
    genres?: string[];
    rating?: number;
    status?: string;
    contentRating?: ContentRating;
    externalIds?: ExternalIds;
    seasons?: SeasonSummary[];
    episodes: Episode[];
    relations?: MediaRelation[];
  }

  export type SubtitleSource =
    | { kind: "url"; url: string; headers?: Record<string, string> }
    | { kind: "inline_content"; content: string };

  export interface SubtitleTrack {
    id?: string;
    source: SubtitleSource;
    lang: string;
    label: string;
    format: SubtitleFormat;
    isDefault?: boolean;
  }

  export interface SkipSegment {
    type: SkipSegmentType;
    startMs: number;
    endMs?: number;
    source?: string;
    confidence?: number;
  }

  export interface StreamCandidate {
    url: string;
    kind: StreamKind;
    quality?: string;
    label: string;
    language?: string;
    audioType?: AudioType;
    priority?: number;
    isDefault?: boolean;
    flags?: StreamFlag[];
    headers?: Record<string, string>;
    needsExtractor?: boolean;
    subtitles?: SubtitleTrack[];
    skipSegments?: SkipSegment[];
  }

  export interface StreamResult {
    streams: StreamCandidate[];
    subtitles?: SubtitleTrack[];
    skipSegments?: SkipSegment[];
  }

  export interface HomeSection {
    id: string;
    title: string;
    layout?: HomeSectionLayout;
    items: MediaSummary[];
    nextCursor?: string | null;
  }

  export interface HomeFeed {
    sections: HomeSection[];
  }

  export interface SearchPage {
    items: MediaSummary[];
    hasMore: boolean;
  }

  export interface SubtitleQuery {
    title: string;
    originalTitle?: string;
    year?: number;
    mediaType: MediaType;
    season?: number;
    episode?: number;
    externalIds?: ExternalIds;
    preferredLanguages?: string[];
  }

  export interface SubtitleCandidate {
    id: string;
    lang: string;
    label: string;
    format: SubtitleFormat;
    releaseName?: string;
    sourceName?: string;
    downloads?: number;
    hearingImpaired?: boolean;
  }

  export interface ResolvedSubtitle {
    format: SubtitleFormat;
    source: SubtitleSource;
  }

  export interface VesselPlugin {
    getHomeFeed?(cursor?: string | null): Promise<HomeFeed>;
    search?(
      query: string,
      filters: Record<string, string>,
      page: number,
    ): Promise<SearchPage>;
    getDetails?(nativeId: string): Promise<MediaDetail>;
    getSeasonEpisodes?(nativeId: string, seasonId: string): Promise<Episode[]>;
    getStreams?(streamId: string): Promise<StreamResult>;
    searchSubtitles?(query: SubtitleQuery): Promise<SubtitleCandidate[]>;
    resolveSubtitle?(subtitleId: string): Promise<ResolvedSubtitle>;
  }

  export interface HttpRequestOptions {
    headers?: Record<string, string>;
    timeoutMs?: number;
    followRedirects?: boolean;
  }

  export interface HttpFullRequestOptions extends HttpRequestOptions {
    method: string;
    url: string;
    body?: string | Record<string, unknown>;
  }

  export interface HttpResponse {
    status: number;
    url: string;
    headers: Record<string, string>;
    text(encoding?: string): string;
    json<T = unknown>(): T;
    bytes(): Uint8Array;
  }

  export interface ArchiveEntry {
    name: string;
    bytes: Uint8Array;
    text(encoding?: string): string;
  }

  export interface HtmlElement {
    tagName(): string;
    text(): string;
    ownText(): string;
    html(): string;
    outerHtml(): string;
    attr(name: string): string | null;
    attrs(): Record<string, string>;
    hasClass(name: string): boolean;
    matches(css: string): boolean;
    select(css: string): HtmlElement[];
    selectOne(css: string): HtmlElement | null;
    children(): HtmlElement[];
    parent(): HtmlElement | null;
    next(): HtmlElement | null;
    prev(): HtmlElement | null;
  }

  export interface HtmlDocument {
    html(): string;
    select(css: string): HtmlElement[];
    selectOne(css: string): HtmlElement | null;
  }

  export interface EvalEnvOptions {
    url?: string;
    userAgent?: string;
    cookies?: Record<string, string>;
  }

  export const http: {
    get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
    post(
      url: string,
      body?: string | Record<string, unknown> | null,
      opts?: HttpRequestOptions,
    ): Promise<HttpResponse>;
    request(opts: HttpFullRequestOptions): Promise<HttpResponse>;
  };

  export const html: {
    parse(rawHtml: string): HtmlDocument;
  };

  export const crypto: {
    base64Encode(input: string | Uint8Array): string;
    base64Decode(b64: string): string;
    base64DecodeBytes(b64: string): Uint8Array;
    hexEncode(input: string | Uint8Array): string;
    hexDecode(hex: string): Uint8Array;
    md5(input: string): string;
    sha1(input: string): string;
    sha256(input: string): string;
    hmacSha256(key: string, data: string): string;
    aesEncrypt(
      plain: string,
      key: string,
      iv?: string,
      mode?: "cbc" | "ecb" | "gcm",
    ): string;
    aesDecrypt(
      cipherBase64: string,
      key: string,
      iv?: string,
      mode?: "cbc" | "ecb" | "gcm",
    ): string;
    rc4(data: string, key: string): string;
  };

  export const storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    getSetting<T = unknown>(key: string): Promise<T | null>;
  };

  export const archive: {
    unzipEntries(bytes: Uint8Array): ArchiveEntry[];
    gunzip(bytes: Uint8Array): Uint8Array;
    decodeText(bytes: Uint8Array, encoding?: string): string;
  };

  export function unpack(packedJs: string): string;

  export function evalWithEnv<T = unknown>(
    script: string,
    env?: EvalEnvOptions,
  ): Promise<T>;

  export function definePlugin<T extends VesselPlugin>(plugin: T): T;
}

declare const vessel: {
  http: typeof import("vessel").http;
  html: typeof import("vessel").html;
  crypto: typeof import("vessel").crypto;
  archive: typeof import("vessel").archive;
  storage: typeof import("vessel").storage;
  unpack: typeof import("vessel").unpack;
  evalWithEnv: typeof import("vessel").evalWithEnv;
  definePlugin: typeof import("vessel").definePlugin;
};
