import { z } from "zod";
import type { Json } from "../http";

// ── search domain types ──────────────────────────────────────────

export const searchItem = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
  publishedAt: z.string().optional(),
  durationSeconds: z.number().nullish(),
  channelUrl: z.string().nullish(),
  viewCount: z.number().nullish(),
});

export type SearchItem = z.infer<typeof searchItem>;

export const successfulSearch = z.object({
  success: z.literal(true),
  data: z.array(searchItem),
});

export type SuccessfulSearch = z.infer<typeof successfulSearch>;

export type SearchResult = SuccessfulSearch | { success: false; error: string };

export type FreshnessRange = { from: string; to?: string };
export type Freshness = "day" | "week" | "month" | "year" | FreshnessRange;

export type SearchFilters = {
  freshness?: Freshness;
  includeDomains?: string[];
  excludeDomains?: string[];
  type?: "web" | "news" | "video";
  country?: string;
  language?: string;
  safeSearch?: "strict" | "moderate" | "off";
  exactMatch?: boolean;
  searchDepth?: "fast" | "deep";
};

export type SearchContext = {
  limit: number;
  signal: AbortSignal;
  key: string;
  filters: SearchFilters;
  proxy?: string;
};

export type Provider = {
  kind: import("../shared/provider-kind").ProviderKind;
  env?: string;
  supports?: (filters: SearchFilters) => boolean;
  search: (query: string, ctx: SearchContext) => Promise<SearchItem[]>;
};

// ── ProviderSpec types ───────────────────────────────────────────

export type FilterSupport = (filters: SearchFilters) => boolean;

export type Parse = (query: string, body: string) => SearchItem[] | Promise<SearchItem[]>;

export type Mcp = {
  kind: "mcp";
  url: string;
  tool: string;
  parse: Parse;
  preferStructured?: boolean;
  args: (query: string, limit: number, filters: SearchFilters) => Json;
  supports?: FilterSupport;
};

export type Get = {
  method: "GET";
  url: (query: string, limit: number, filters: SearchFilters) => string;
  parse: Parse;
  headers?: (key: string) => Record<string, string>;
  supports?: FilterSupport;
} & ({ kind: "api"; env: string } | { kind: "public" });

export type Post = {
  method: "POST";
  url: (query: string, limit: number, filters: SearchFilters) => string;
  parse: Parse;
  headers?: (key: string) => Record<string, string>;
  body: (query: string, limit: number, filters: SearchFilters) => Json;
  supports?: FilterSupport;
} & ({ kind: "api"; env: string } | { kind: "public" });

export type Scrape = {
  kind: "scrape";
  url: (query: string, filters: SearchFilters) => string;
  parse: Parse;
  headers?: Record<string, string>;
  supports?: FilterSupport;
};

export type Custom = {
  kind: "public" | "scrape";
  search: Provider["search"];
  supports?: FilterSupport;
};

export type ProviderSpec = Mcp | Get | Post | Scrape | Custom;
