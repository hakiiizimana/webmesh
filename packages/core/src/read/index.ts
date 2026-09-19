import { agentBrowserPath } from "../browser";
import { blockedUrl, type ResolveAddresses } from "../network";
import { createRouter, type RouterOptions, usesProxy } from "../router";
import { fetchInBrowser } from "./providers/browser";
import { fetchDirect } from "./providers/direct";
import { fetchExaMcp } from "./providers/exa";
import { fetchFirecrawl } from "./providers/firecrawl";
import { fetchJina } from "./providers/jina";
import { fetchParallelMcp } from "./providers/parallel";
import { acceptsSocialUrl, fetchSocial } from "./providers/social";
import { defaultYtDlpPath } from "./providers/ytDlp";
import type { Fetcher, FetchResult, Page, PageFormat } from "./types";

const BUDGET_MS = 30_000;
const HEDGE_MS = 3_000;
const MAX_CHARACTERS = 50_000;

export { pageFromHtml } from "./providers/page";
export { pageFromExa } from "./providers/exa";
export { pageFromFirecrawl } from "./providers/firecrawl";
export { pageFromJina } from "./providers/jina";
export { pageFromParallel } from "./providers/parallel";
export type { FetchedPage, Fetcher, FetchContext, FetchResult, Page, PageFormat } from "./types";

export const fetchers = {
  "yt-dlp": {
    kind: "local",
    available: () => Bun.file(defaultYtDlpPath).size > 0,
    accepts: acceptsSocialUrl,
    formats: ["markdown"],
    fetch: fetchSocial,
  },
  direct: { kind: "local", formats: ["markdown", "html"], fetch: fetchDirect },
  browser: { kind: "browser", available: () => agentBrowserPath() !== null, formats: ["markdown"], fetch: fetchInBrowser },
  "jina-reader": { kind: "public", formats: ["markdown", "html"], fetch: fetchJina },
  "firecrawl-free": { kind: "public", formats: ["markdown", "html"], fetch: fetchFirecrawl },
  "exa-mcp": { kind: "mcp", formats: ["markdown"], fetch: fetchExaMcp },
  "parallel-mcp": { kind: "mcp", formats: ["markdown"], fetch: fetchParallelMcp },
  jina: { kind: "api", env: "JINA_API_KEY", formats: ["markdown", "html"], fetch: fetchJina },
  firecrawl: { kind: "api", env: "FIRECRAWL_API_KEY", formats: ["markdown", "html"], fetch: fetchFirecrawl },
} satisfies Record<string, Fetcher>;

export type FetcherId = keyof typeof fetchers;

export const isFetcherId = (id: string): id is FetcherId => Object.hasOwn(fetchers, id);

type FetchOptions<Id> = { format?: PageFormat; maxCharacters?: number; only?: Id[] };

export function createFetch<R extends Record<string, Fetcher>>(
  registry: R,
  options: RouterOptions & { proxy?: string; allowPrivateNetworks?: boolean; resolve?: ResolveAddresses },
) {
  type Id = keyof R & string;
  const router = createRouter("fetch", registry, options, { budgetMs: BUDGET_MS, hedgeMs: HEDGE_MS });

  async function fetchPage(
    url: string,
    { format = "markdown", maxCharacters = MAX_CHARACTERS, only }: FetchOptions<Id> = {},
  ): Promise<FetchResult> {
    const protocol = URL.parse(url)?.protocol;
    if (protocol !== "https:" && protocol !== "http:") return { success: false, error: "Only http and https URLs can be fetched." };
    if (!options.allowPrivateNetworks) {
      const error = await blockedUrl(url, options.resolve);
      if (error) return { success: false, error };
    }
    const configured = (only ?? router.ids).filter(router.isReady);
    const ready = configured.filter((id) => {
      const fetcher = router.get(id);
      return fetcher.formats.includes(format) && (fetcher.accepts?.(url) ?? true);
    });
    if (ready.length === 0) {
      return {
        success: false,
        error: configured.length === 0 ? "No fetchers configured." : `No configured fetchers can return ${format}.`,
      };
    }

    return router.route(ready, {
      call: async (id, key, signal): Promise<Page> => {
        const proxy = usesProxy(router.get(id).kind) ? options.proxy : undefined;
        const page = await router.get(id).fetch(url, {
          format,
          maxCharacters,
          signal,
          key,
          proxy,
          allowPrivateNetworks: options.allowPrivateNetworks,
          resolve: options.resolve,
        });
        const content = page.content.trim();
        return { ...page, format, content: content.slice(0, maxCharacters), truncated: content.length > maxCharacters };
      },
      accept: (page) => page.content.length > 0,
      empty: "empty page",
    });
  }

  return { fetch: fetchPage, status: router.status };
}
