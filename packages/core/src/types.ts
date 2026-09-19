export type SearchItem = {
  title: string;
  url: string;
  description: string;
  /** Publish date as YYYY-MM-DD, when the provider reports an absolute one. */
  publishedAt?: string;
  durationSeconds?: number | null;
  channelUrl?: string | null;
  viewCount?: number | null;
};

/** `provider` answered; `attempts` says what happened to each provider tried or skipped before it. */
export type SuccessfulSearch = { success: true; provider: string; attempts: string[]; data: SearchItem[] };

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
};

export type ProviderKind = "api" | "mcp" | "public" | "scrape";

export type Provider = {
  kind: ProviderKind;
  env?: string;
  supports?: (filters: SearchFilters) => boolean;
  search: (query: string, ctx: SearchContext) => Promise<SearchItem[]>;
};
