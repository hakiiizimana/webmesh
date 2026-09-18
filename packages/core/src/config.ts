import type { Json } from "./http";
import type { ParserId } from "./parser";
import type { Freshness, FreshnessRange, Provider, SearchFilters } from "./types";
import { searchYoutube } from "./youtube";

type FilterName = keyof SearchFilters;
type FilterSupport = (filters: SearchFilters) => boolean;

const filterNames = [
  "freshness",
  "includeDomains",
  "excludeDomains",
  "type",
  "country",
  "language",
  "safeSearch",
  "exactMatch",
  "searchDepth",
] as const satisfies readonly FilterName[];

function hasFilterValue(value: SearchFilters[FilterName]): boolean {
  if (value === undefined || value === false) return false;
  return !Array.isArray(value) || value.length > 0;
}

function onlyFilters(...supportedNames: FilterName[]): FilterSupport {
  const supported = new Set(supportedNames);
  return (filters) =>
    !filterNames.some((name) => hasFilterValue(filters[name]) && !supported.has(name));
}

const noFilters = onlyFilters();

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateStart(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function dateEnd(date: string): string {
  return `${date}T23:59:59.999Z`;
}

function isFreshnessRange(value: Freshness): value is FreshnessRange {
  return Object.hasOwn(Object(value), "from");
}

function dateRange(freshness: Freshness | undefined): { from: string; to?: string } | undefined {
  if (!freshness) return undefined;
  if (isFreshnessRange(freshness)) return freshness;

  const now = new Date();
  const from = new Date(now);
  const days = { day: 1, week: 7, month: 31, year: 365 }[freshness];
  from.setUTCDate(from.getUTCDate() - days);
  return { from: dateOnly(from), to: dateOnly(now) };
}

function quoteQuery(query: string): string {
  return `"${query.replaceAll('"', '\\"')}"`;
}

function queryWithOperators(query: string, filters: SearchFilters, domains = false): string {
  let value = filters.exactMatch ? quoteQuery(query) : query;
  if (!domains) return value;

  const include = filters.includeDomains ?? [];
  const exclude = filters.excludeDomains ?? [];
  if (include.length > 0) value += ` (${include.map((domain) => `site:${domain}`).join(" OR ")})`;
  for (const domain of exclude) value += ` -site:${domain}`;
  return value;
}

function countryName(country: string): string {
  if (!/^[a-z]{2}$/i.test(country)) return country;
  return new Intl.DisplayNames(["en"], { type: "region" }).of(country.toUpperCase()) ?? country;
}

function addJsonField<T extends object>(object: T, key: string, value: Json | undefined): void {
  if (value !== undefined) Object.assign(object, { [key]: value });
}

function braveFreshness(freshness: Freshness | undefined): string | undefined {
  if (!freshness) return undefined;
  if (!isFreshnessRange(freshness)) return { day: "pd", week: "pw", month: "pm", year: "py" }[freshness];
  return `${freshness.from}to${freshness.to ?? dateOnly(new Date())}`;
}

function firecrawlFreshness(freshness: Freshness | undefined): string | undefined {
  if (!freshness) return undefined;
  if (!isFreshnessRange(freshness)) return { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness];
  const format = (value: string) => {
    const [year, month, day] = value.split("-");
    return `${month}/${day}/${year}`;
  };
  return `cdr:1,cd_min:${format(freshness.from)},cd_max:${format(freshness.to ?? dateOnly(new Date()))}`;
}

type Mcp = {
  kind: "mcp";
  url: string;
  tool: string;
  parser: ParserId;
  args: (query: string, limit: number, filters: SearchFilters) => Json;
  supports?: FilterSupport;
};

type Get = {
  method: "GET";
  url: (query: string, limit: number, filters: SearchFilters) => string;
  parser: ParserId;
  headers?: (key: string) => Record<string, string>;
  supports?: FilterSupport;
} & ({ kind: "api"; env: string } | { kind: "public" });

type Post = {
  method: "POST";
  url: (query: string, limit: number, filters: SearchFilters) => string;
  parser: ParserId;
  headers?: (key: string) => Record<string, string>;
  body: (query: string, limit: number, filters: SearchFilters) => Json;
  supports?: FilterSupport;
} & ({ kind: "api"; env: string } | { kind: "public" });

type Scrape = {
  kind: "scrape";
  url: (query: string, filters: SearchFilters) => string;
  parser: ParserId;
  headers?: Record<string, string>;
  supports?: FilterSupport;
};

type Custom = {
  kind: "public";
  search: Provider["search"];
  supports?: FilterSupport;
};

export type ProviderSpec = Mcp | Get | Post | Scrape | Custom;

const SESSION = crypto.randomUUID().replaceAll("-", "");
const keenableBody = (query: string, limit: number) => ({ query, max_results: Math.min(limit, 50) });

function exaSupports(filters: SearchFilters): boolean {
  return onlyFilters(
    "freshness",
    "includeDomains",
    "excludeDomains",
    "country",
    "safeSearch",
    "exactMatch",
  )(filters) && (filters.type === undefined || filters.type === "web");
}

function braveSupports(filters: SearchFilters): boolean {
  return onlyFilters(
    "freshness",
    "includeDomains",
    "excludeDomains",
    "type",
    "country",
    "language",
    "safeSearch",
    "exactMatch",
  )(filters) && (filters.type === undefined || filters.type === "web" || filters.type === "news");
}

function tavilySupports(filters: SearchFilters): boolean {
  return onlyFilters(
    "freshness",
    "includeDomains",
    "excludeDomains",
    "type",
    "country",
    "language",
    "safeSearch",
    "exactMatch",
    "searchDepth",
  )(filters) && (filters.type === undefined || filters.type === "web" || filters.type === "news");
}

function parallelSupports(filters: SearchFilters): boolean {
  if (
    !onlyFilters("freshness", "includeDomains", "excludeDomains", "searchDepth")(filters)
  )
    return false;
  if (filters.includeDomains?.length && filters.excludeDomains?.length) return false;
  return filters.freshness === undefined || !isFreshnessRange(filters.freshness) || filters.freshness.to === undefined;
}

function firecrawlSupports(filters: SearchFilters): boolean {
  if (
    !onlyFilters(
      "freshness",
      "includeDomains",
      "excludeDomains",
      "type",
      "country",
      "safeSearch",
      "exactMatch",
    )(filters)
  )
    return false;
  if (filters.type === "video") return false;
  return !(filters.type === "news" && filters.freshness !== undefined);
}

function exaBody(query: string, limit: number, filters: SearchFilters): Json {
  const range = dateRange(filters.freshness);
  const body = {
    query: queryWithOperators(query, filters),
    numResults: limit,
    type: "auto",
    contents: { highlights: { maxCharacters: 600 } },
  };
  if (range) {
    addJsonField(body, "startPublishedDate", dateStart(range.from));
    addJsonField(body, "endPublishedDate", range.to ? dateEnd(range.to) : undefined);
  }
  addJsonField(body, "includeDomains", filters.includeDomains?.length ? filters.includeDomains : undefined);
  addJsonField(body, "excludeDomains", filters.excludeDomains?.length ? filters.excludeDomains : undefined);
  addJsonField(body, "userLocation", filters.country);
  addJsonField(body, "moderation", filters.safeSearch ? filters.safeSearch !== "off" : undefined);
  return body;
}

function parallelBody(query: string, _limit: number, filters: SearchFilters): Json {
  const range = dateRange(filters.freshness);
  const sourcePolicy = {};
  addJsonField(sourcePolicy, "include_domains", filters.includeDomains?.length ? filters.includeDomains : undefined);
  addJsonField(sourcePolicy, "exclude_domains", filters.excludeDomains?.length ? filters.excludeDomains : undefined);
  addJsonField(sourcePolicy, "after_date", range?.from);
  const body = {
    objective: queryWithOperators(query, filters),
    search_queries: [queryWithOperators(query, filters)],
    mode: filters.searchDepth === "deep" ? "advanced" : "fast",
  };
  if (Object.keys(sourcePolicy).length > 0) addJsonField(body, "advanced_settings", { source_policy: sourcePolicy });
  return body;
}

function tavilyBody(query: string, limit: number, filters: SearchFilters): Json {
  const body = {
    query,
    max_results: limit,
  };
  addJsonField(body, "search_depth", filters.searchDepth ? (filters.searchDepth === "deep" ? "advanced" : "basic") : undefined);
  addJsonField(body, "topic", filters.type ? (filters.type === "news" ? "news" : "general") : undefined);
  if (filters.freshness !== undefined) {
    if (isFreshnessRange(filters.freshness)) {
      addJsonField(body, "start_date", filters.freshness.from);
      addJsonField(body, "end_date", filters.freshness.to);
      addJsonField(body, "filter_by_published_date", true);
    } else {
      addJsonField(body, "time_range", filters.freshness);
    }
  }
  addJsonField(body, "include_domains", filters.includeDomains?.length ? filters.includeDomains : undefined);
  addJsonField(body, "exclude_domains", filters.excludeDomains?.length ? filters.excludeDomains : undefined);
  addJsonField(body, "country", filters.country ? countryName(filters.country) : undefined);
  if (filters.language) {
    addJsonField(body, "language", filters.language);
    addJsonField(body, "filter_by_language", true);
  }
  addJsonField(body, "safe_search", filters.safeSearch ? filters.safeSearch !== "off" : undefined);
  addJsonField(body, "exact_match", filters.exactMatch);
  return body;
}

function firecrawlBody(query: string, limit: number, filters: SearchFilters): Json {
  const bothDomainFilters = Boolean(filters.includeDomains?.length && filters.excludeDomains?.length);
  const body = {
    query: queryWithOperators(query, filters, Boolean(bothDomainFilters)),
    limit,
  };
  addJsonField(body, "sources", filters.type ? [filters.type] : undefined);
  addJsonField(body, "includeDomains", filters.includeDomains?.length && !bothDomainFilters ? filters.includeDomains : undefined);
  addJsonField(body, "excludeDomains", filters.excludeDomains?.length && !bothDomainFilters ? filters.excludeDomains : undefined);
  addJsonField(body, "location", filters.country ? countryName(filters.country) : undefined);
  addJsonField(body, "safe", filters.safeSearch ? filters.safeSearch !== "off" : undefined);
  addJsonField(body, "tbs", firecrawlFreshness(filters.freshness));
  return body;
}

function braveUrl(query: string, limit: number, filters: SearchFilters): string {
  const endpoint = filters.type === "news" ? "news" : "web";
  const params = new URLSearchParams({ q: queryWithOperators(query, filters, true), count: String(Math.min(limit, 20)) });
  const freshness = braveFreshness(filters.freshness);
  if (freshness) params.set("freshness", freshness);
  if (filters.country) params.set("country", filters.country.toUpperCase());
  if (filters.language) params.set("search_lang", filters.language);
  if (filters.safeSearch) params.set("safesearch", filters.safeSearch);
  return `https://api.search.brave.com/res/v1/${endpoint}/search?${params}`;
}

function youtubeSupports(filters: SearchFilters): boolean {
  return (
    filters.type === "video" &&
    onlyFilters("freshness", "type", "country", "language")(filters) &&
    (filters.country === undefined || /^[a-z]{2}$/i.test(filters.country)) &&
    (filters.freshness === undefined || !isFreshnessRange(filters.freshness))
  );
}

/** Key order = rotation order. `env` means the provider joins only when that var is set. */
export const providers = {
  "parallel-mcp": {
    kind: "mcp",
    url: "https://search.parallel.ai/mcp",
    tool: "web_search",
    parser: "parallel",
    args: (query) => ({ objective: query, search_queries: [query], session_id: SESSION }),
    supports: noFilters,
  },
  "exa-mcp": {
    kind: "mcp",
    url: "https://mcp.exa.ai/mcp",
    tool: "web_search_exa",
    parser: "exa-mcp",
    args: (query, limit) => ({ query, numResults: limit }),
    supports: noFilters,
  },
  "keenable-public": {
    kind: "public",
    url: () => "https://api.keenable.ai/v1/search/public",
    method: "POST",
    parser: "keenable",
    headers: () => ({ "x-keenable-title": "webmesh" }),
    body: keenableBody,
    supports: noFilters,
  },
  "duckduckgo-html": {
    kind: "scrape",
    url: (query) => `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`,
    parser: "duckduckgo-html",
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      cookie: "kl=us-en",
    },
    supports: noFilters,
  },
  "brave-web": {
    kind: "scrape",
    url: (query) => `https://search.brave.com/search?${new URLSearchParams({ q: query, source: "web" })}`,
    parser: "brave-web",
    supports: noFilters,
  },
  mwmbl: {
    kind: "public",
    method: "GET",
    url: (query) => `https://api.mwmbl.org/api/v1/search/?${new URLSearchParams({ s: query })}`,
    parser: "mwmbl",
    supports: noFilters,
  },
  "duckduckgo-lite": {
    kind: "scrape",
    url: (query) => `https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query })}`,
    parser: "duckduckgo-lite",
    supports: noFilters,
  },
  "firecrawl-free": {
    kind: "public",
    method: "POST",
    url: () => "https://api.firecrawl.dev/v2/search",
    parser: "firecrawl",
    body: firecrawlBody,
    supports: firecrawlSupports,
  },
  exa: {
    kind: "api",
    env: "EXA_API_KEY",
    method: "POST",
    url: () => "https://api.exa.ai/search",
    parser: "exa",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: exaBody,
    supports: exaSupports,
  },
  parallel: {
    kind: "api",
    env: "PARALLEL_API_KEY",
    method: "POST",
    url: () => "https://api.parallel.ai/v1/search",
    parser: "parallel",
    headers: (key) => ({ "x-api-key": key }),
    body: parallelBody,
    supports: parallelSupports,
  },
  tavily: {
    kind: "api",
    env: "TAVILY_API_KEY",
    method: "POST",
    url: () => "https://api.tavily.com/search",
    parser: "tavily",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: tavilyBody,
    supports: tavilySupports,
  },
  keenable: {
    kind: "api",
    env: "KEENABLE_API_KEY",
    method: "POST",
    url: () => "https://api.keenable.ai/v1/search",
    parser: "keenable",
    headers: (key) => ({ "x-api-key": key }),
    body: keenableBody,
    supports: noFilters,
  },
  brave: {
    kind: "api",
    env: "BRAVE_API_KEY",
    method: "GET",
    url: braveUrl,
    parser: "brave",
    headers: (key) => ({ "x-subscription-token": key }),
    supports: braveSupports,
  },
  youtube: {
    kind: "public",
    search: searchYoutube,
    supports: youtubeSupports,
  },
  firecrawl: {
    kind: "api",
    env: "FIRECRAWL_API_KEY",
    method: "POST",
    url: () => "https://api.firecrawl.dev/v2/search",
    parser: "firecrawl",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: firecrawlBody,
    supports: firecrawlSupports,
  },
} satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof providers;

export const isProviderId = (id: string): id is ProviderId => Object.hasOwn(providers, id);
