import { z } from "zod";
import { providers as specs, type ProviderId, type ProviderSpec } from "./config";
import { SoftBlockError } from "./html";
import { HttpError, type Json, NetworkError, request } from "./http";
import { parse } from "./parser";
import { type CacheStore, memoryCache, NEW_PROVIDER, type ProviderHealth, type RoutingState, type StateStore } from "./state";
import type { Provider, SearchContext, SearchFilters, SearchItem, SearchResult, SuccessfulSearch } from "./types";

const BLOCKED_MS = 10 * 60_000;
const TRANSIENT_MS = 30_000;
const BUDGET_MS = 15_000;
const HEDGE_MS = 2_500;
const RETRY_DELAY_MS = 400;
const CACHE_DEFAULT_TTL_MS = 20 * 60_000;
const CACHE_WEEK_TTL_MS = 60 * 60_000;
const CACHE_LONG_TTL_MS = 24 * 60 * 60_000;

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
  /** Where results are cached. Defaults to an in-process cache. */
  cache?: CacheStore;
  env?: Record<string, string | undefined>;
  /** Total time one search may take across every provider it tries. */
  budgetMs?: number;
  /** How long a provider may run before the next one starts alongside it. */
  hedgeMs?: number;
  /** Base pause before the single retry on a network error or 5xx; jittered up to double. */
  retryDelayMs?: number;
  now?: () => number;
  random?: () => number;
};

/** Drops filter values every provider already uses by default, so they don't rule providers out. */
function withoutDefaults(filters: SearchFilters): SearchFilters {
  const normalized = { ...filters };
  if (normalized.type === "web") delete normalized.type;
  if (normalized.searchDepth === "fast") delete normalized.searchDepth;
  return normalized;
}

/** Keeps results inside includeDomains and outside excludeDomains, whatever the provider did with them. */
function inDomains(url: string, filters: SearchFilters): boolean {
  const host = URL.parse(url)?.hostname ?? "";
  const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (filters.includeDomains?.length && !filters.includeDomains.some(matches)) return false;
  return !filters.excludeDomains?.some(matches);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs `call`, and once more after `delayMs` if it failed on the network or with a 5xx. */
async function withRetry<T>(call: () => Promise<T>, delayMs: number, signal: AbortSignal): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const retryable = err instanceof NetworkError || (err instanceof HttpError && err.status >= 500);
    if (!retryable || signal.aborted) throw err;
    await pause(delayMs, signal);
    if (signal.aborted) throw err;
    return call();
  }
}

/** Reliability counts more than speed; the floor lets a struggling provider still earn its way back. */
function weight({ success, latencyMs }: ProviderHealth): number {
  return Math.max(success, 0.2) ** 2 * (1_000 / Math.max(latencyMs, 250));
}

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

/**
 * Builds the router over a provider registry. Each search tries free providers before keyed ones,
 * favoring those that answer often and fast, starts the next provider alongside a slow one, and
 * gives up once the time budget is spent.
 */
export function createSearch<R extends Record<string, Provider>>(registry: R, options: SearchOptions) {
  type Id = keyof R & string;
  type Outcome = { id: Id; items: SearchItem[] } | { id: Id; failure: string };
  const ids = Object.keys(registry).filter((id): id is Id => Object.hasOwn(registry, id));
  const env = options.env ?? process.env;
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  const hedgeMs = options.hedgeMs ?? HEDGE_MS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const get = (id: Id): Provider => {
    const provider = registry[id];
    if (!provider) throw new Error(`unknown provider ${String(id)}`);
    return provider;
  };
  const cache = options.cache ?? memoryCache();
  const { store } = options;

  const keyFor = (id: Id) => {
    const name = get(id).env;
    return name ? (env[name] ?? "") : "";
  };
  const isReady = (id: Id) => !get(id).env || keyFor(id) !== "";

  /** Free providers first, keyed ones as a fallback; within a tier, a shuffle weighted by health. */
  const rank = (candidates: Id[], health: RoutingState["health"]): Id[] =>
    candidates
      .map((id) => ({
        id,
        tier: get(id).env ? 1 : 0,
        key: Math.log(1 - random()) / weight(health[id] ?? NEW_PROVIDER),
      }))
      .sort((a, b) => a.tier - b.tier || b.key - a.key)
      .map(({ id }) => id);

  /** One provider's turn. Records its health and cooldown unless the search was already settled. */
  async function attempt(id: Id, query: string, context: SearchContext): Promise<Outcome> {
    const startedAt = performance.now();
    try {
      const found = await withRetry(
        () => get(id).search(query, context),
        retryDelayMs * (1 + random()),
        context.signal,
      );
      if (context.signal.aborted) return { id, failure: "cancelled" };
      const items = found
        .filter((item) => item.url && inDomains(item.url, context.filters))
        .map(tidy)
        .slice(0, context.limit);
      if (items.length === 0) {
        store.observe(id, { success: 0 });
        return { id, failure: "no results" };
      }
      store.observe(id, { success: 1, latencyMs: performance.now() - startedAt });
      return { id, items };
    } catch (err) {
      if (context.signal.aborted) return { id, failure: "cancelled" };
      store.observe(id, { success: 0 });
      const ms = err instanceof HttpError ? httpCooldown(err) : err instanceof SoftBlockError ? BLOCKED_MS : TRANSIENT_MS;
      if (ms > 0) store.bench(id, now() + ms);
      return { id, failure: (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 120) ?? "" };
    }
  }

  async function search(
    query: string,
    { limit = 10, only, filters: requested = {} }: { limit?: number; only?: Id[]; filters?: SearchFilters } = {},
  ): Promise<SearchResult> {
    const filters = withoutDefaults(requested);
    const configured = (only ?? ids).filter(isReady);
    const ready = configured.filter((id) => get(id).supports?.(filters) ?? true);
    if (ready.length === 0) {
      return {
        success: false,
        error: configured.length === 0 ? "No providers configured." : "No configured providers support these filters.",
      };
    }

    const key = cacheKey(query, limit, ready, filters);
    const cached = cache.read(key, now());
    if (cached) return cached;

    const state = store.load();
    const cooling = ready.filter((id) => (state.benched[id] ?? 0) > now());
    const failures = cooling.map((id) => `${id}: cooling down`);
    const queue = rank(ready.filter((id) => !cooling.includes(id)), state.health);

    const stop = new AbortController();
    const budget = setTimeout(() => stop.abort(), budgetMs);
    const expired = new Promise<"expired">((resolve) =>
      stop.signal.addEventListener("abort", () => resolve("expired"), { once: true }),
    );
    const running = new Map<Id, { startedAt: number; outcome: Promise<Outcome> }>();
    const launch = () => {
      const id = queue.shift();
      if (id === undefined || stop.signal.aborted) return;
      const context = { limit, signal: stop.signal, key: keyFor(id), filters };
      running.set(id, { startedAt: performance.now(), outcome: attempt(id, query, context) });
    };

    try {
      launch();
      while (running.size > 0) {
        const hedge = new AbortController();
        const next = await Promise.race([
          expired,
          pause(hedgeMs, hedge.signal).then(() => "hedge" as const),
          ...[...running.values()].map((run) => run.outcome),
        ]);
        hedge.abort();
        if (next === "expired") {
          failures.push(...[...running.keys()].map((id) => `${id}: timed out`));
          break;
        }
        if (next === "hedge") {
          launch();
          continue;
        }
        running.delete(next.id);
        if ("items" in next) {
          const result: SuccessfulSearch = { success: true, provider: next.id, attempts: failures, data: next.items };
          cache.write(key, result, now() + cacheTtl(filters));
          return result;
        }
        failures.push(`${next.id}: ${next.failure}`);
        launch();
      }
      return { success: false, error: `All providers failed. ${failures.join("; ")}` };
    } finally {
      clearTimeout(budget);
      // Providers still running lost the race; their elapsed time still counts against their speed.
      for (const [id, run] of running) store.observe(id, { latencyMs: performance.now() - run.startedAt });
      stop.abort();
    }
  }

  /** Readiness, cooldown, and health per provider. `successRate` and `latencyMs` are null until it has been tried. */
  function status() {
    const state = store.load();
    return ids.map((id) => {
      const health = state.health[id];
      return {
        id,
        kind: get(id).kind,
        ready: isReady(id),
        needs: isReady(id) ? undefined : get(id).env,
        coolingDownSeconds: Math.max(0, Math.ceil(((state.benched[id] ?? 0) - now()) / 1000)),
        successRate: health ? Math.round(health.success * 100) / 100 : null,
        latencyMs: health ? Math.round(health.latencyMs) : null,
      };
    });
  }

  return { search, status };
}
