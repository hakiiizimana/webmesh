import { agentBrowserPath } from "../browser";
import { blockedUrl, type ResolveAddresses } from "../network";
import { createRouter, type RouterOptions, usesProxy } from "../router";
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
import { defaultYtDlpPath } from "./providers/ytDlp";
import type { Json } from "../http";
import type { FetchFormat, Fetcher, FetchResult, Page, PageFormat } from "./types";

const BUDGET_MS = 30_000;
const HEDGE_MS = 3_000;
const MAX_CHARACTERS = 50_000;

export { pageFromHtml } from "./providers/page";
export { pageFromExa } from "./providers/exa";
export { pageFromFirecrawl } from "./providers/firecrawl";
export { pageFromJina } from "./providers/jina";
export { pageFromMarkdownNew } from "./providers/markdownNew";
export { pageFromParallel } from "./providers/parallel";
export { pageFromTinyfish } from "./providers/tinyfish";
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
  firecrawl: { kind: "api", env: "FIRECRAWL_API_KEY", formats: ["markdown", "html", "rawHtml", "links", "json"], fetch: fetchFirecrawl },
} satisfies Record<string, Fetcher>;

export type FetcherId = keyof typeof fetchers;

export const isFetcherId = (id: string): id is FetcherId => Object.hasOwn(fetchers, id);

type FetchOptions<Id> = {
  format?: PageFormat;
  formats?: FetchFormat[];
  schema?: Json;
  maxCharacters?: number;
  only?: Id[];
};

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
  options: RouterOptions & { proxy?: string; allowPrivateNetworks?: boolean; resolve?: ResolveAddresses },
) {
  type Id = keyof R & string;
  const router = createRouter("fetch", registry, options, { budgetMs: BUDGET_MS, hedgeMs: HEDGE_MS });

  async function fetchPage(
    url: string,
    { format, formats: requestedFormats, schema, maxCharacters = MAX_CHARACTERS, only }: FetchOptions<Id> = {},
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
      const error = await blockedUrl(url, options.resolve);
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
          resolve: options.resolve,
        });
        const content = page.content.trim();
        return {
          ...page,
          format: primary,
          content: content.slice(0, maxCharacters),
          truncated: content.length > maxCharacters,
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
    });
    return result.success ? { success: true, data: result.data } : result;
  }

  return { fetch: fetchPage, status: router.status };
}
