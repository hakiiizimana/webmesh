export type SearchItem = {
  title: string;
  url: string;
  description: string;
};

export type SearchResult = { success: true; data: SearchItem[] } | { success: false; error: string };

export type FreshnessRange = { from: string; to?: string };
export type Freshness = "day" | "week" | "month" | "year" | FreshnessRange;

export type SearchFilters = {
  freshness?: Freshness;
  includeDomains?: string[];
  excludeDomains?: string[];
  type?: "web" | "news";
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
};

export type ProviderKind = "api" | "mcp" | "public" | "scrape";

export type Provider = {
  kind: ProviderKind;
  env?: string;
  supports?: (filters: SearchFilters) => boolean;
  search: (query: string, ctx: SearchContext) => Promise<SearchItem[]>;
};
