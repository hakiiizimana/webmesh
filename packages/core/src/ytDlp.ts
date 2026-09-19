import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;
const DEFAULT_CACHE_TTL_MS = 3_600_000;
const RETRIES = "3";

const bundledYtDlpPath = join(import.meta.dir, "../bin/yt-dlp");
export const defaultYtDlpPath = existsSync(bundledYtDlpPath) ? bundledYtDlpPath : Bun.which("yt-dlp") ?? bundledYtDlpPath;

export type YtDlpCaptionTrack = {
  readonly language: string;
  readonly name: string | null;
  readonly automatic: boolean;
  readonly formats: readonly { readonly extension: string | null; readonly name: string | null; readonly protocol: string | null }[];
};

export type YtDlpMetadata = {
  readonly id: string;
  readonly site: string;
  readonly extractor: string;
  readonly mediaType: "video" | "audio" | "image" | "playlist" | "unknown";
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly creator: string | null;
  readonly creatorId: string | null;
  readonly creatorUrl: string | null;
  readonly publishedAt: string | null;
  readonly durationSeconds: number | null;
  readonly thumbnail: string | null;
  readonly engagement: {
    readonly views: number | null;
    readonly likes: number | null;
    readonly comments: number | null;
    readonly reposts: number | null;
  };
  readonly tags: readonly string[];
  readonly categories: readonly string[];
  readonly chapters: readonly { readonly title: string; readonly startSeconds: number; readonly endSeconds: number | null }[];
  readonly captions: readonly YtDlpCaptionTrack[];
  readonly liveStatus: string | null;
  readonly availability: string | null;
  readonly ageLimit: number | null;
};

export type YtDlpErrorKind = "cancelled" | "timeout" | "output-limit" | "spawn" | "exit" | "invalid-json" | "options";
export type YtDlpError = { readonly kind: YtDlpErrorKind; readonly message: string; readonly exitCode?: number };
export type YtDlpResult = { readonly success: true; readonly data: YtDlpMetadata } | { readonly success: false; readonly error: YtDlpError };
export type YtDlpCache = {
  get: (key: string, now: number) => YtDlpMetadata | undefined;
  set: (key: string, value: YtDlpMetadata, expiresAt: number) => void;
};
export type YtDlpOptions = {
  readonly executablePath?: string;
  readonly signal?: AbortSignal;
  readonly proxy?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly cache?: YtDlpCache | false;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
};

type JsonObject = { readonly [key: string]: unknown };
type SettledOutput = PromiseSettledResult<string>;
class OutputLimitError extends Error {}
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

const stringAt = (value: JsonObject, ...keys: string[]): string | null => {
  for (const key of keys) {
    const result = value[key];
    if (typeof result === "string" && result.trim()) return result;
  }
  return null;
};

const numberAt = (value: JsonObject, ...keys: string[]): number | null => {
  for (const key of keys) {
    const result = value[key];
    if (typeof result === "number" && Number.isFinite(result) && result >= 0) return result;
  }
  return null;
};

const stringsAt = (value: JsonObject, key: string): string[] => {
  const items = value[key];
  return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
};

const dateFrom = (value: string | null): string | null => {
  if (value === null) return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
};

const mediaTypeFrom = (value: JsonObject): YtDlpMetadata["mediaType"] => {
  const type = stringAt(value, "_type");
  if (type === "playlist" || type === "multi_video") return "playlist";
  const video = stringAt(value, "vcodec");
  const audio = stringAt(value, "acodec");
  if (video === "none" && audio !== null && audio !== "none") return "audio";
  if (numberAt(value, "duration") !== null || video !== null) return "video";
  return stringAt(value, "thumbnail") === null ? "unknown" : "image";
};

const chaptersFrom = (value: JsonObject): YtDlpMetadata["chapters"] => {
  if (!Array.isArray(value.chapters)) return [];
  return value.chapters.flatMap((chapter) => {
    if (!isObject(chapter)) return [];
    const title = stringAt(chapter, "title");
    const startSeconds = numberAt(chapter, "start_time");
    return title === null || startSeconds === null ? [] : [{ title, startSeconds, endSeconds: numberAt(chapter, "end_time") }];
  });
};

const captionsFrom = (value: unknown, automatic: boolean): YtDlpCaptionTrack[] => {
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([language, raw]) => {
    if (!Array.isArray(raw)) return [];
    const objects = raw.filter(isObject);
    const formats = objects.map((format) => ({
      extension: stringAt(format, "ext"),
      name: stringAt(format, "name"),
      protocol: stringAt(format, "protocol"),
    }));
    if (formats.length === 0) return [];
    return [{ language, name: stringAt(objects[0]!, "name"), automatic, formats }];
  });
};

const metadataFrom = (value: unknown, sourceUrl: string): YtDlpMetadata | null => {
  if (!isObject(value)) return null;
  const id = stringAt(value, "id");
  const title = stringAt(value, "title", "fulltitle");
  if (id === null || title === null) return null;
  const extractor = stringAt(value, "extractor_key", "extractor") ?? "unknown";
  return {
    id,
    site: stringAt(value, "webpage_url_domain") ?? extractor.toLowerCase(),
    extractor,
    mediaType: mediaTypeFrom(value),
    title,
    description: stringAt(value, "description") ?? "",
    url: stringAt(value, "webpage_url", "original_url") ?? sourceUrl,
    creator: stringAt(value, "uploader", "channel", "creator", "artist"),
    creatorId: stringAt(value, "uploader_id", "channel_id", "creator_id", "artist_id"),
    creatorUrl: stringAt(value, "uploader_url", "channel_url", "creator_url"),
    publishedAt: dateFrom(stringAt(value, "upload_date", "release_date", "timestamp")),
    durationSeconds: numberAt(value, "duration"),
    thumbnail: stringAt(value, "thumbnail"),
    engagement: {
      views: numberAt(value, "view_count"),
      likes: numberAt(value, "like_count"),
      comments: numberAt(value, "comment_count"),
      reposts: numberAt(value, "repost_count"),
    },
    tags: stringsAt(value, "tags"),
    categories: stringsAt(value, "categories"),
    chapters: chaptersFrom(value),
    captions: [...captionsFrom(value.subtitles, false), ...captionsFrom(value.automatic_captions, true)],
    liveStatus: stringAt(value, "live_status"),
    availability: stringAt(value, "availability"),
    ageLimit: numberAt(value, "age_limit"),
  };
};

export function memoryYtDlpCache(maxEntries = 256): YtDlpCache {
  const entries = new Map<string, { value: YtDlpMetadata; expiresAt: number }>();
  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= now) return undefined;
      entries.set(key, entry);
      return structuredClone(entry.value);
    },
    set(key, value, expiresAt) {
      entries.delete(key);
      entries.set(key, { value: structuredClone(value), expiresAt });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

const defaultCache = memoryYtDlpCache();
const pending = new Map<string, Promise<YtDlpResult>>();
const failure = (kind: YtDlpErrorKind, message: string, exitCode?: number): YtDlpResult => ({
  success: false,
  error: exitCode === undefined ? { kind, message } : { kind, message, exitCode },
});
const outputError = (result: SettledOutput): YtDlpError | null => {
  if (result.status === "fulfilled") return null;
  if (result.reason instanceof OutputLimitError) return { kind: "output-limit", message: result.reason.message };
  return { kind: "exit", message: result.reason instanceof Error ? result.reason.message : "yt-dlp output could not be read" };
};
const outputText = (result: SettledOutput): string => result.status === "fulfilled" ? result.value : "";

async function readOutput(stream: ReadableStream<Uint8Array<ArrayBuffer>>, maxBytes: number, budget: { bytes: number }, onLimit: () => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      budget.bytes += chunk.value.byteLength;
      if (budget.bytes > maxBytes) {
        onLimit();
        throw new OutputLimitError(`yt-dlp output exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function runYtDlp(sourceUrl: string, options: YtDlpOptions): Promise<YtDlpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const args = [options.executablePath ?? defaultYtDlpPath, "--dump-single-json", "--skip-download", "--no-playlist", "--retries", RETRIES,
    ...(options.proxy === undefined ? [] : ["--proxy", options.proxy]), sourceUrl];
  let process: Bun.Subprocess;
  try {
    process = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return failure("spawn", `yt-dlp could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  let cancelled = false;
  let timedOut = false;
  const kill = (): void => process.kill();
  const cancel = (): void => { cancelled = true; kill(); };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const stdoutStream = process.stdout;
  const stderrStream = process.stderr;
  if (stdoutStream === undefined || typeof stdoutStream === "number" || stderrStream === undefined || typeof stderrStream === "number") {
    kill(); await process.exited; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
    return failure("spawn", "yt-dlp did not expose piped output");
  }
  const budget = { bytes: 0 };
  const [stdout, stderr] = await Promise.allSettled([
    readOutput(stdoutStream, maxOutputBytes, budget, kill),
    readOutput(stderrStream, maxOutputBytes, budget, kill),
  ]);
  const exitCode = await process.exited;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", cancel);
  if (cancelled) return failure("cancelled", "yt-dlp was cancelled");
  if (timedOut) return failure("timeout", `yt-dlp timed out after ${timeoutMs}ms`);
  const streamError = outputError(stdout) ?? outputError(stderr);
  if (streamError) return { success: false, error: streamError };
  if (exitCode !== 0) return failure("exit", outputText(stderr).trim().split("\n")[0] || `yt-dlp exited with code ${exitCode}`, exitCode);
  let parsed: unknown;
  try { parsed = JSON.parse(outputText(stdout)); } catch { return failure("invalid-json", "yt-dlp returned invalid JSON"); }
  const metadata = metadataFrom(parsed, sourceUrl);
  return metadata === null ? failure("invalid-json", "yt-dlp returned incomplete metadata") : { success: true, data: metadata };
}

export async function extractYtDlpMetadata(sourceUrl: string, options: YtDlpOptions = {}): Promise<YtDlpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return failure("options", "timeoutMs must be greater than zero");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) return failure("options", "maxOutputBytes must be a positive integer");
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) return failure("options", "cacheTtlMs must not be negative");
  if (options.signal?.aborted) return failure("cancelled", "yt-dlp was cancelled");
  const now = options.now?.() ?? Date.now();
  const cache = options.cache === false ? undefined : options.cache ?? defaultCache;
  const key = JSON.stringify([options.executablePath ?? defaultYtDlpPath, sourceUrl]);
  const cached = cache?.get(key, now);
  if (cached) return { success: true, data: cached };
  const existing = pending.get(key);
  if (existing) return existing;
  const extraction = runYtDlp(sourceUrl, options).then((result) => {
    if (result.success && cacheTtlMs > 0) cache?.set(key, result.data, now + cacheTtlMs);
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, extraction);
  return extraction;
}
