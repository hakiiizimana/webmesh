import { providers as specs, type ProviderId, type ProviderSpec } from "./config";
import { HttpError, request } from "./http";
import { callMcp } from "./mcp";
import { parse } from "./parser";
import { createRouter, type RouterOptions, type Task, usesProxy } from "./router";
import { type CacheStore, memoryCache } from "./state";
import type { Provider, SearchContext, SearchFilters, SearchItem, SearchResult, SuccessfulSearch } from "./types";

const FUSION_WINDOW_MS = 1_500;
const HEDGE_MS = 400;
const RRF_K = 60;
const MAX_PER_DOMAIN = 2;
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

function cacheKey(
  query: string,
  limit: number,
  only: readonly string[] | undefined,
  filters: SearchContext["filters"],
): string {
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
    version: 2,
    query: query.trim().replace(/\s+/g, " "),
    limit,
    only: only?.length ? [...only].sort() : undefined,
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

function hostOf(url: string): string {
  return URL.parse(url)?.hostname ?? "";
}

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "spm",
  "yclid",
]);

function normalizeUrl(raw: string): string | undefined {
  const url = URL.parse(raw);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  for (const name of Array.from(url.searchParams.keys())) {
    const lower = name.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || lower.startsWith("utm_")) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function fuse(lists: SearchItem[][]): SearchItem[] {
  const scored = new Map<string, { item: SearchItem; score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    const seen = new Set<string>();
    for (const [index, item] of list.entries()) {
      const url = normalizeUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const score = 1 / (RRF_K + index + 1);
      const existing = scored.get(url);
      if (existing) existing.score += score;
      else scored.set(url, { item: { ...item, url }, score, order: order++ });
    }
  }
  return [...scored.values()].sort((a, b) => b.score - a.score || a.order - b.order).map((entry) => entry.item);
}

function diversify(items: SearchItem[], limit: number): SearchItem[] {
  const counts = new Map<string, number>();
  const chosen: SearchItem[] = [];
  const overflow: SearchItem[] = [];
  for (const item of items) {
    if (chosen.length >= limit) break;
    const host = hostOf(item.url);
    const count = counts.get(host) ?? 0;
    if (count < MAX_PER_DOMAIN) {
      counts.set(host, count + 1);
      chosen.push(item);
    } else {
      overflow.push(item);
    }
  }
  for (const item of overflow) {
    if (chosen.length >= limit) break;
    chosen.push(item);
  }
  return chosen;
}

export function createSearch<R extends Record<string, Provider>>(registry: R, options: SearchOptions) {
  type Id = keyof R & string;
  const router = createRouter("search", registry, options, { budgetMs: FUSION_WINDOW_MS, hedgeMs: HEDGE_MS });
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

    const key = cacheKey(query, limit, only, filters);
    const cached = cache.read(key, router.now());
    if (cached) return cached;

    const task: Task<Id, SearchItem[]> = {
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
    };

    const collect = async (ids: Id[]) => {
      const outcomes = await Promise.all(ids.map((id) => router.route([id], task)));
      const lists: SearchItem[][] = [];
      const failures: string[] = [];
      for (const outcome of outcomes) {
        if (outcome.success) lists.push(outcome.data);
        else failures.push(outcome.error.replace("All providers failed. ", ""));
      }
      return { lists, failures };
    };

    const free = ready.filter((id) => !router.get(id).env);
    const keyed = ready.filter((id) => router.get(id).env);

    const primary = await collect(free);
    let lists = primary.lists;
    let failures = primary.failures;
    if (lists.length === 0 && keyed.length > 0) {
      const fallback = await collect(keyed);
      lists = fallback.lists;
      failures = [...failures, ...fallback.failures];
    }

    const data = diversify(fuse(lists), limit);
    if (data.length === 0) {
      return {
        success: false,
        error: failures.length > 0 ? `All providers failed. ${failures.join("; ")}` : "No usable results.",
      };
    }

    const result: SuccessfulSearch = { success: true, data };
    cache.write(key, result, router.now() + cacheTtl(filters));
    return result;
  }

  return { search, status: router.status };
}
