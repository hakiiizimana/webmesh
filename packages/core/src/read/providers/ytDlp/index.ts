import type { ResolveAddresses } from "../../../network";
import { transcriptFrom } from "./captions";
import { isObject, metadataFrom } from "./parse";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, defaultYtDlpPath, failure, runYtDlp } from "./process";

const DEFAULT_CACHE_TTL_MS = 3_600_000;

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
  readonly transcript: string | null;
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
  readonly language?: string;
  readonly allowPrivateNetworks?: boolean;
  readonly resolve?: ResolveAddresses;
};

export { defaultYtDlpPath } from "./process";
export { captionToMarkdown } from "./captions";

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
  const key = JSON.stringify([options.executablePath ?? defaultYtDlpPath, sourceUrl, options.language ?? ""]);
  const cached = cache?.get(key, now);
  if (cached) return { success: true, data: cached };
  const existing = pending.get(key);
  if (existing) return existing;
  const extraction = runYtDlp(sourceUrl, {
    executablePath: options.executablePath,
    proxy: options.proxy,
    signal: options.signal,
    timeoutMs,
    maxOutputBytes,
  })
    .then(async (result): Promise<YtDlpResult> => {
      if (!result.success) return result;
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return failure("invalid-json", "yt-dlp returned invalid JSON");
      }
      const transcript = isObject(parsed) ? await transcriptFrom(parsed, options) : null;
      const metadata = metadataFrom(parsed, sourceUrl, transcript);
      return metadata === null ? failure("invalid-json", "yt-dlp returned incomplete metadata") : { success: true, data: metadata };
    })
    .then((result) => {
      if (result.success && cacheTtlMs > 0) cache?.set(key, result.data, now + cacheTtlMs);
      return result;
    })
    .finally(() => pending.delete(key));
  pending.set(key, extraction);
  return extraction;
}
