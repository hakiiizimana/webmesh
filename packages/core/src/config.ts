import type { Json } from "./http";
import type { ParserId } from "./parser";

type Mcp = {
  kind: "mcp";
  url: string;
  tool: string;
  parser: ParserId;
  args: (query: string, limit: number) => Json;
};

type Get = {
  method: "GET";
  url: (query: string, limit: number) => string;
  parser: ParserId;
  headers?: (key: string) => Record<string, string>;
} & ({ kind: "api"; env: string } | { kind: "public" });

type Post = {
  method: "POST";
  url: (query: string, limit: number) => string;
  parser: ParserId;
  headers?: (key: string) => Record<string, string>;
  body: (query: string, limit: number) => Json;
} & ({ kind: "api"; env: string } | { kind: "public" });

type Scrape = {
  kind: "scrape";
  url: (query: string) => string;
  parser: ParserId;
  headers?: Record<string, string>;
};

export type ProviderSpec = Mcp | Get | Post | Scrape;

const SESSION = crypto.randomUUID().replaceAll("-", "");
const keenableBody = (query: string, limit: number) => ({ query, max_results: Math.min(limit, 50) });

/** Key order = rotation order. `env` means the provider joins only when that var is set. */
export const providers = {
  "parallel-mcp": {
    kind: "mcp",
    url: "https://search.parallel.ai/mcp",
    tool: "web_search",
    parser: "parallel",
    args: (query) => ({ objective: query, search_queries: [query], session_id: SESSION }),
  },
  "exa-mcp": {
    kind: "mcp",
    url: "https://mcp.exa.ai/mcp",
    tool: "web_search_exa",
    parser: "exa-mcp",
    args: (query, limit) => ({ query, numResults: limit }),
  },
  "keenable-public": {
    kind: "public",
    url: () => "https://api.keenable.ai/v1/search/public",
    method: "POST",
    parser: "keenable",
    headers: () => ({ "x-keenable-title": "webmesh" }),
    body: keenableBody,
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
  },
  "brave-web": {
    kind: "scrape",
    url: (query) => `https://search.brave.com/search?${new URLSearchParams({ q: query, source: "web" })}`,
    parser: "brave-web",
  },
  mwmbl: {
    kind: "public",
    method: "GET",
    url: (query) => `https://api.mwmbl.org/api/v1/search/?${new URLSearchParams({ s: query })}`,
    parser: "mwmbl",
  },
  "duckduckgo-lite": {
    kind: "scrape",
    url: (query) => `https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query })}`,
    parser: "duckduckgo-lite",
  },
  "firecrawl-free": {
    kind: "public",
    method: "POST",
    url: () => "https://api.firecrawl.dev/v2/search",
    parser: "firecrawl",
    body: (query, limit) => ({ query, limit }),
  },
  exa: {
    kind: "api",
    env: "EXA_API_KEY",
    method: "POST",
    url: () => "https://api.exa.ai/search",
    parser: "exa",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: (query, limit) => ({ query, numResults: limit, type: "auto", contents: { highlights: { maxCharacters: 600 } } }),
  },
  parallel: {
    kind: "api",
    env: "PARALLEL_API_KEY",
    method: "POST",
    url: () => "https://api.parallel.ai/v1/search",
    parser: "parallel",
    headers: (key) => ({ "x-api-key": key }),
    body: (query) => ({ objective: query, search_queries: [query], mode: "fast" }),
  },
  tavily: {
    kind: "api",
    env: "TAVILY_API_KEY",
    method: "POST",
    url: () => "https://api.tavily.com/search",
    parser: "tavily",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: (query, limit) => ({ query, max_results: limit }),
  },
  keenable: {
    kind: "api",
    env: "KEENABLE_API_KEY",
    method: "POST",
    url: () => "https://api.keenable.ai/v1/search",
    parser: "keenable",
    headers: (key) => ({ "x-api-key": key }),
    body: keenableBody,
  },
  brave: {
    kind: "api",
    env: "BRAVE_API_KEY",
    method: "GET",
    url: (query, limit) =>
      `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(Math.min(limit, 20)) })}`,
    parser: "brave",
    headers: (key) => ({ "x-subscription-token": key }),
  },
  firecrawl: {
    kind: "api",
    env: "FIRECRAWL_API_KEY",
    method: "POST",
    url: () => "https://api.firecrawl.dev/v2/search",
    parser: "firecrawl",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: (query, limit) => ({ query, limit }),
  },
} satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof providers;

export const isProviderId = (id: string): id is ProviderId => Object.hasOwn(providers, id);
