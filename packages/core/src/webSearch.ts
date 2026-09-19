import { providers as specs, type ProviderId, type ProviderSpec } from "./config";
import { HttpError, request } from "./http";
import { callMcp } from "./mcp";
import { parse } from "./parser";
import { createRouter, type RouterOptions, usesProxy } from "./router";
import { type CacheStore, memoryCache } from "./state";
import type { Provider, SearchContext, SearchFilters, SearchItem, SearchResult } from "./types";

const BUDGET_MS = 15_000;
const HEDGE_MS = 2_500;
const CACHE_DEFAULT_TTL_MS = 20 * 60_000;
const CACHE_WEEK_TTL_MS = 60 * 60_000;
const CACHE_LONG_TTL_MS = 24 * 60 * 60_000;

async function invoke(spec: ProviderSpec, query: string, ctx: SearchContext): Promise<SearchItem[]> {
  const { limit, signal, key, filters } = ctx;
  if (spec.kind === "mcp") {
    const body = await callMcp(
      spec.url,
      spec.tool,
      spec.args(query, limit, filters),
      signal,
      spec.parser === "parallel",
    );
    return parse(spec.parser, query, body);
  }
  if ("search" in spec) return spec.search(query, ctx);
  if (spec.kind === "scrape") {
    const res = await request(spec.url(query, filters), { signal, browser: true, headers: spec.headers, proxy: ctx.proxy });
    if (res.status === 202) throw new HttpError(202, undefined, "HTTP 202: DuckDuckGo bot check");
    return parse(spec.parser, query, await res.text());
  }
  const headers = spec.headers?.(key) ?? {};
  const res =
    spec.method === "POST"
      ? await request(spec.url(query, limit, filters), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...headers },
          body: JSON.stringify(spec.body(query, limit, filters)),
          signal,
        })
      : await request(spec.url(query, limit, filters), { headers: { accept: "application/json", ...headers }, signal });
  return parse(spec.parser, query, await res.text());
}

function bind(spec: ProviderSpec): Provider {
  return {
    kind: spec.kind,
    env: spec.kind === "api" ? spec.env : undefined,
    supports: spec.supports,
    search: (query, ctx) => invoke(spec, query, ctx),
  };
}

export const providers = {
  "parallel-mcp": bind(specs["parallel-mcp"]),
  "exa-mcp": bind(specs["exa-mcp"]),
  "keenable-public": bind(specs["keenable-public"]),
  "duckduckgo-html": bind(specs["duckduckgo-html"]),
  "brave-web": bind(specs["brave-web"]),
  mwmbl: bind(specs.mwmbl),
  "duckduckgo-lite": bind(specs["duckduckgo-lite"]),
  "firecrawl-free": bind(specs["firecrawl-free"]),
  exa: bind(specs.exa),
  parallel: bind(specs.parallel),
  tavily: bind(specs.tavily),
  keenable: bind(specs.keenable),
  brave: bind(specs.brave),
  youtube: bind(specs.youtube),
  firecrawl: bind(specs.firecrawl),
} satisfies { [K in ProviderId]: Provider };

type SearchOptions = RouterOptions & {
  cache?: CacheStore;
  proxy?: string;
};

function withoutDefaults(filters: SearchFilters): SearchFilters {
  const normalized = { ...filters };
  if (normalized.type === "web") delete normalized.type;
  if (normalized.searchDepth === "fast") delete normalized.searchDepth;
  return normalized;
}

function inDomains(url: string, filters: SearchFilters): boolean {
  const host = URL.parse(url)?.hostname ?? "";
  const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (filters.includeDomains?.length && !filters.includeDomains.some(matches)) return false;
  return !filters.excludeDomains?.some(matches);
}

function tidy(item: SearchItem): SearchItem {
  const description = item.description.replace(/\s+/g, " ").trim();
  return {
    ...item,
    title: item.title.replace(/\s+/g, " ").trim(),
    url: item.url,
    description,
  };
}

function cacheTtl(filters: SearchContext["filters"]): number {
  const freshness = filters.freshness;
  switch (freshness) {
    case "week":
      return CACHE_WEEK_TTL_MS;
    case "month":
    case "year":
      return CACHE_LONG_TTL_MS;
    case "day":
      return CACHE_DEFAULT_TTL_MS;
    default:
      return freshness?.to ? CACHE_LONG_TTL_MS : CACHE_DEFAULT_TTL_MS;
  }
}

function cacheKey(query: string, limit: number, providerIds: readonly string[], filters: SearchContext["filters"]): string {
  const freshness = (() => {
    switch (filters.freshness) {
      case "day":
      case "week":
      case "month":
      case "year":
        return filters.freshness;
      default:
        return filters.freshness ? { from: filters.freshness.from, to: filters.freshness.to } : undefined;
    }
  })();

  return JSON.stringify({
    version: 1,
    query: query.trim().replace(/\s+/g, " "),
    limit,
    providers: providerIds,
    filters: {
      freshness,
      includeDomains: filters.includeDomains?.length ? [...filters.includeDomains].sort() : undefined,
      excludeDomains: filters.excludeDomains?.length ? [...filters.excludeDomains].sort() : undefined,
      type: filters.type,
      country: filters.country,
      language: filters.language,
      safeSearch: filters.safeSearch,
      exactMatch: filters.exactMatch === true ? true : undefined,
      searchDepth: filters.searchDepth,
    },
  });
}

export function createSearch<R extends Record<string, Provider>>(registry: R, options: SearchOptions) {
  type Id = keyof R & string;
  const router = createRouter("search", registry, options, { budgetMs: BUDGET_MS, hedgeMs: HEDGE_MS });
  const cache = options.cache ?? memoryCache();

  async function search(
    query: string,
    { limit = 10, only, filters: requested = {} }: { limit?: number; only?: Id[]; filters?: SearchFilters } = {},
  ): Promise<SearchResult> {
    const filters = withoutDefaults(requested);
    const configured = (only ?? router.ids).filter(router.isReady);
    const ready = configured.filter((id) => router.get(id).supports?.(filters) ?? true);
    if (ready.length === 0) {
      return {
        success: false,
        error: configured.length === 0 ? "No providers configured." : "No configured providers support these filters.",
      };
    }

    const key = cacheKey(query, limit, ready, filters);
    const cached = cache.read(key, router.now());
    if (cached) return cached;

    const result = await router.route(ready, {
      call: async (id, apiKey, signal) =>
        (await router.get(id).search(query, {
          limit,
          signal,
          key: apiKey,
          filters,
          proxy: usesProxy(router.get(id).kind) ? options.proxy : undefined,
        }))
          .filter((item) => item.url && inDomains(item.url, filters))
          .map(tidy)
          .slice(0, limit),
      accept: (items) => items.length > 0,
      empty: "no results",
    });
    if (result.success) cache.write(key, result, router.now() + cacheTtl(filters));
    return result;
  }

  return { search, status: router.status };
}
