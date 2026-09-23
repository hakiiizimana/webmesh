import { agentBrowserPath } from "../browser";
import { blockedUrl, type ResolveAddresses } from "../network";
import { createRouter, type RouterOptions, usesProxy } from "../router";
import { type CacheStore, memoryCache } from "../state";
import { cacheKey, cacheTtl, cachedFetch } from "./cache";
import { fetchInBrowser } from "./providers/browser";
import { fetchDirect } from "./providers/direct";
import { fetchExaMcp } from "./providers/exa";
import { fetchFirecrawl } from "./providers/firecrawl";
import { fetchJina } from "./providers/jina";
import { fetchMarkdownNew } from "./providers/markdownNew";
import { fetchParallelMcp } from "./providers/parallel";
import { acceptsSocialUrl, fetchSocial } from "./providers/social";
import { fetchTinyfish } from "./providers/tinyfish";
import { fetchWayback } from "./providers/wayback";
import { fetchZenRows } from "./providers/zenrows";
import { defaultYtDlpPath } from "./providers/ytDlp";
import type { Json } from "../http";
import { mapLimit } from "../shared/concurrency";
import type { FetchFormat, Fetcher, FetchResult, Page, PageFormat } from "./types";

const BUDGET_MS = 30_000;
const HEDGE_MS = 3_000;
const ATTEMPT_MS = 10_000;
const MAX_CHARACTERS = 50_000;
const MAX_LINKS = 1_000;
const BATCH_CONCURRENCY = 3;

export { pageFromHtml } from "./providers/page";
export { pageFromExa } from "./providers/exa";
export { pageFromFirecrawl } from "./providers/firecrawl";
export { pageFromJina } from "./providers/jina";
export { pageFromMarkdownNew } from "./providers/markdownNew";
export { pageFromParallel } from "./providers/parallel";
export { pageFromTinyfish } from "./providers/tinyfish";
export { pageFromZenRows } from "./providers/zenrows";
export { fetchFormat, page } from "./types";
export type { FetchFormat, FetchedPage, Fetcher, FetchContext, FetchResult, Page, PageFormat, PageMetadata } from "./types";

export const fetchers = {
  "yt-dlp": {
    kind: "local",
    available: () => Bun.file(defaultYtDlpPath).size > 0,
    accepts: acceptsSocialUrl,
    formats: ["markdown"],
    fetch: fetchSocial,
  },
  direct: { kind: "local", formats: ["markdown", "html", "rawHtml", "links"], fetch: fetchDirect },
  browser: { kind: "browser", available: () => agentBrowserPath() !== null, formats: ["markdown"], fetch: fetchInBrowser },
  "jina-reader": { kind: "public", formats: ["markdown", "html"], fetch: fetchJina },
  "markdown-new": { kind: "public", formats: ["markdown"], fetch: fetchMarkdownNew },
  "firecrawl-free": { kind: "public", formats: ["markdown", "html", "rawHtml", "links"], fetch: fetchFirecrawl },
  "exa-mcp": { kind: "mcp", formats: ["markdown"], fetch: fetchExaMcp },
  "parallel-mcp": { kind: "mcp", formats: ["markdown"], fetch: fetchParallelMcp },
  wayback: { kind: "public", manual: true, formats: ["markdown", "html"], fetch: fetchWayback },
  jina: { kind: "api", env: "JINA_API_KEY", formats: ["markdown", "html"], fetch: fetchJina },
  tinyfish: { kind: "api", env: "TINYFISH_API_KEY", formats: ["markdown", "html"], fetch: fetchTinyfish },
  zenrows: { kind: "api", env: "ZENROWS_API_KEY", formats: ["markdown"], fetch: fetchZenRows },
  firecrawl: { kind: "api", env: "FIRECRAWL_API_KEY", formats: ["markdown", "html", "rawHtml", "links", "json"], fetch: fetchFirecrawl },
} satisfies Record<string, Fetcher>;

export type FetcherId = keyof typeof fetchers;

export const isFetcherId = (id: string): id is FetcherId => Object.hasOwn(fetchers, id);

export const fetcherIds = Object.keys(fetchers).filter(isFetcherId);

type FetchOptions<Id> = {
  format?: PageFormat;
  formats?: FetchFormat[];
  schema?: Json;
  maxCharacters?: number;
  only?: Id[];
  signal?: AbortSignal;
};

export type FetchedOne = { url: string } & FetchResult;

function primaryFormat(formats: readonly FetchFormat[]): PageFormat {
  return formats.includes("markdown") ? "markdown" : "html";
}

function contentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return `sha256:${hasher.digest("hex")}`;
}

export function createFetch<R extends Record<string, Fetcher>>(
  registry: R,
  options: RouterOptions & {
    proxy?: string;
    allowPrivateNetworks?: boolean;
    allowPrivateHosts?: readonly string[];
    resolve?: ResolveAddresses;
    cache?: CacheStore;
  },
) {
  type Id = keyof R & string;
  const router = createRouter("fetch", registry, { ...options, attemptMs: ATTEMPT_MS }, { budgetMs: BUDGET_MS, hedgeMs: HEDGE_MS });
  const cache = options.cache ?? memoryCache();

  async function fetchPage(
    url: string,
    { format, formats: requestedFormats, schema, maxCharacters = MAX_CHARACTERS, only, signal }: FetchOptions<Id> = {},
  ): Promise<FetchResult> {
    const formats = requestedFormats ?? [format ?? "markdown"];
    if (formats.length === 0) return { success: false, error: "Pass at least one fetch format." };
    if (formats.includes("json") && schema === undefined) {
      return { success: false, error: "JSON extraction needs a schema." };
    }
    if (schema !== undefined && !formats.includes("json")) {
      return { success: false, error: "A schema can only be used with the json format." };
    }
    const protocol = URL.parse(url)?.protocol;
    if (protocol !== "https:" && protocol !== "http:") return { success: false, error: "Only http and https URLs can be fetched." };
    if (!options.allowPrivateNetworks) {
      const error = await blockedUrl(url, options.resolve, options.allowPrivateHosts);
      if (error) return { success: false, error };
    }
    const configured = (only ?? router.ids.filter((id) => !router.get(id).manual)).filter(router.isReady);
    const ready = configured.filter((id) => {
      const fetcher = router.get(id);
      return formats.every((format) => fetcher.formats.includes(format)) && (fetcher.accepts?.(url) ?? true);
    });
    if (ready.length === 0) {
      return {
        success: false,
        error: configured.length === 0 ? "No fetchers configured." : `No configured fetchers can return ${formats.join(", ")}.`,
      };
    }

    const primary = primaryFormat(formats);

    const key = cacheKey(url, formats, schema, maxCharacters, only);
    const cached = cache.read(key, cachedFetch, router.now());
    if (cached) return cached;

    const result = await router.route(ready, {
      call: async (id, key, signal): Promise<Page> => {
        const proxy = usesProxy(router.get(id).kind) ? options.proxy : undefined;
        const page = await router.get(id).fetch(url, {
          format: primary,
          formats,
          schema,
          maxCharacters,
          signal,
          key,
          proxy,
          allowPrivateNetworks: options.allowPrivateNetworks,
          allowPrivateHosts: options.allowPrivateHosts,
          resolve: options.resolve,
        });
        const content = page.content.trim();
        // rawHtml and links go to the agent and the cache too, so they share the content's limit.
        return {
          ...page,
          format: primary,
          content: content.slice(0, maxCharacters),
          rawHtml: page.rawHtml?.slice(0, maxCharacters),
          links: page.links?.slice(0, MAX_LINKS),
          truncated:
            content.length > maxCharacters ||
            (page.rawHtml?.length ?? 0) > maxCharacters ||
            (page.links?.length ?? 0) > MAX_LINKS,
          metadata: {
            ...page.metadata,
            sourceURL: url,
            url: page.url,
            title: page.title,
            publishedAt: page.publishedAt,
            fetchedAt: new Date(router.now()).toISOString(),
            contentHash: contentHash(page.rawHtml ?? content),
          },
        };
      },
      accept: (page) =>
        formats.every((format) => {
          if (format === "rawHtml") return page.rawHtml !== undefined;
          if (format === "links") return page.links !== undefined;
          if (format === "json") return page.json !== undefined;
          return page.content.length > 0;
        }),
      empty: formats.length === 1 && (formats[0] === "markdown" || formats[0] === "html") ? "empty page" : "missing requested page data",
    }, signal);
    if (!result.success) return result;
    cache.write(key, { success: true, data: result.data }, router.now() + cacheTtl());
    return { success: true, data: result.data };
  }

  async function fetchMany(urls: readonly string[], options: FetchOptions<Id> = {}): Promise<FetchedOne[]> {
    return mapLimit(urls, BATCH_CONCURRENCY, async (url) => ({ url, ...(await fetchPage(url, options)) }));
  }

  return { fetch: fetchPage, fetchMany, status: router.status };
}
