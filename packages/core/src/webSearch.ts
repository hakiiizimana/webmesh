import { z } from "zod";
import { providers as specs, type ProviderId, type ProviderSpec } from "./config";
import { SoftBlockError } from "./html";
import { HttpError, type Json, request } from "./http";
import { parse } from "./parser";
import type { StateStore } from "./state";
import type { Provider, SearchContext, SearchItem, SearchResult } from "./types";

const BLOCKED_MS = 10 * 60_000;
const TRANSIENT_MS = 30_000;
const CACHE_DEFAULT_TTL_MS = 20 * 60_000;
const CACHE_WEEK_TTL_MS = 60 * 60_000;
const CACHE_LONG_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 128;

const toolResponse = z.object({
  result: z
    .object({
      content: z.array(z.object({ text: z.string().optional() })).default([]),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

async function callMcp(
  url: string,
  name: string,
  args: Json,
  signal: AbortSignal,
  preferStructured: boolean,
): Promise<string> {
  const res = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal,
  });
  const raw = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : raw;
  if (!json) throw new Error(`${name}: empty MCP response`);
  const msg = toolResponse.parse(JSON.parse(json));
  const text = msg.result?.content.map((c) => c.text ?? "").join("\n") ?? "";
  if (msg.error || msg.result?.isError) throw new Error(`${name}: ${msg.error?.message ?? text.slice(0, 200)}`);
  if (preferStructured && msg.result?.structuredContent !== undefined) {
    return JSON.stringify(msg.result.structuredContent);
  }
  return text;
}

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
    const res = await request(spec.url(query, filters), { signal, browser: true, headers: spec.headers });
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

type SearchOptions = {
  store: StateStore;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  now?: () => number;
};

function httpCooldown(err: HttpError): number {
  if (err.status === 429) return (err.retryAfter ?? 60) * 1000;
  if (err.status === 401 || err.status === 402 || err.status === 403) return BLOCKED_MS;
  if (err.status === 202 || err.status >= 500) return TRANSIENT_MS;
  return 0;
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

type SuccessfulSearch = Extract<SearchResult, { success: true }>;
type CacheEntry = { result: SuccessfulSearch; expiresAt: number };

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

function copyResult(result: SuccessfulSearch): SuccessfulSearch {
  return { success: true, data: result.data.map((item) => ({ ...item })) };
}

export function createSearch<R extends Record<string, Provider>>(registry: R, options: SearchOptions) {
  type Id = keyof R & string;
  const ids = Object.keys(registry).filter((id): id is Id => Object.hasOwn(registry, id));
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const get = (id: Id): Provider => {
    const provider = registry[id];
    if (!provider) throw new Error(`unknown provider ${String(id)}`);
    return provider;
  };
  const cache = new Map<string, CacheEntry>();

  const readCache = (key: string): SuccessfulSearch | undefined => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return copyResult(entry.result);
  };

  const writeCache = (key: string, result: SuccessfulSearch, filters: SearchContext["filters"]): void => {
    cache.delete(key);
    cache.set(key, { result: copyResult(result), expiresAt: now() + cacheTtl(filters) });
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const keyFor = (id: Id) => {
    const name = get(id).env;
    return name ? (env[name] ?? "") : "";
  };
  const isReady = (id: Id) => !get(id).env || keyFor(id) !== "";

  async function search(
    query: string,
    { limit = 10, only, filters = {} }: { limit?: number; only?: Id[]; filters?: SearchContext["filters"] } = {},
  ): Promise<SearchResult> {
    const configured = (only ?? ids).filter(isReady);
    const ready = configured.filter((id) => get(id).supports?.(filters) ?? true);
    if (ready.length === 0) {
      return {
        success: false,
        error: configured.length === 0 ? "No providers configured." : "No configured providers support these filters.",
      };
    }

    const key = cacheKey(query, limit, ready, filters);
    const cached = readCache(key);
    if (cached) return cached;

    const state = options.store.load();
    const start = (ready.findIndex((id) => id === state.last) + 1) % ready.length;
    const failures: string[] = [];

    for (let step = 0; step < ready.length; step++) {
      const id = ready[(start + step) % ready.length];
      if (id === undefined) continue;
      if ((state.benched[id] ?? 0) > now()) {
        failures.push(`${id}: cooling down`);
        continue;
      }
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        const items = (await get(id).search(query, { limit, signal, key: keyFor(id), filters }))
          .filter((item) => item.url)
          .map(tidy)
          .slice(0, limit);
        if (items.length > 0) {
          state.last = id;
          options.store.save(state);
          const result: SuccessfulSearch = { success: true, data: items };
          writeCache(key, result, filters);
          return result;
        }
        failures.push(`${id}: no results`);
      } catch (err) {
        const ms = err instanceof HttpError ? httpCooldown(err) : err instanceof SoftBlockError ? BLOCKED_MS : TRANSIENT_MS;
        if (ms > 0) state.benched[id] = now() + ms;
        failures.push(`${id}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 120)}`);
      }
    }

    state.last = ready[start];
    options.store.save(state);
    return { success: false, error: `All providers failed. ${failures.join("; ")}` };
  }

  function status() {
    const state = options.store.load();
    return ids.map((id) => ({
      id,
      kind: get(id).kind,
      ready: isReady(id),
      needs: isReady(id) ? undefined : get(id).env,
      coolingDownSeconds: Math.max(0, Math.ceil(((state.benched[id] ?? 0) - now()) / 1000)),
    }));
  }

  return { search, status };
}
