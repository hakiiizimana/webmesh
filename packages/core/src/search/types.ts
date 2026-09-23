import { z } from "zod";
import type { Json } from "../http";

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

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");
const freshnessRange = z.object({ from: day, to: day.optional() });

// The one definition of what a search filter can be; the CLI and MCP validate against it.
export const searchFilters = z.object({
  freshness: z.union([z.enum(["day", "week", "month", "year"]), freshnessRange]).optional(),
  includeDomains: z.array(z.string().min(1)).optional(),
  excludeDomains: z.array(z.string().min(1)).optional(),
  type: z.enum(["web", "news", "video"]).optional(),
  country: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  safeSearch: z.enum(["strict", "moderate", "off"]).optional(),
  exactMatch: z.boolean().optional(),
  searchDepth: z.enum(["fast", "deep"]).optional(),
});

export type SearchFilters = z.infer<typeof searchFilters>;
export type FreshnessRange = z.infer<typeof freshnessRange>;
export type Freshness = NonNullable<SearchFilters["freshness"]>;
export type SearchedOne = { query: string } & SearchResult;

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
  // Excluded from the default provider pool. Only runs when a caller names it.
  manual?: boolean;
  supports?: (filters: SearchFilters) => boolean;
  search: (query: string, ctx: SearchContext) => Promise<SearchItem[]>;
};

export type FilterSupport = (filters: SearchFilters) => boolean;

export type Parse = (query: string, body: string) => SearchItem[] | Promise<SearchItem[]>;

// Registry-level concerns, shared by every provider shape: `manual` keeps a provider out of the
// default pool, and `supports` declares the filters it is willing to honor.
type Registry = { manual?: boolean; supports?: FilterSupport };

export type Mcp = Registry & {
  kind: "mcp";
  url: string;
  tool: string;
  parse: Parse;
  preferStructured?: boolean;
  args: (query: string, limit: number, filters: SearchFilters) => Json;
};

export type Get = Registry & {
  method: "GET";
  url: (query: string, limit: number, filters: SearchFilters) => string;
  parse: Parse;
  headers?: (key: string) => Record<string, string>;
} & ({ kind: "api"; env: string } | { kind: "public" });

export type Post = Registry & {
  method: "POST";
  url: (query: string, limit: number, filters: SearchFilters) => string;
  parse: Parse;
  headers?: (key: string) => Record<string, string>;
  body: (query: string, limit: number, filters: SearchFilters) => Json;
} & ({ kind: "api"; env: string } | { kind: "public" });

export type Scrape = Registry & {
  kind: "scrape";
  url: (query: string, filters: SearchFilters) => string;
  parse: Parse;
  headers?: Record<string, string>;
};

export type Custom = Registry & {
  kind: "public" | "scrape";
  search: Provider["search"];
};

export type ProviderSpec = Mcp | Get | Post | Scrape | Custom;
