import { z } from "zod";

export const searchItem = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
  /** Publish date as YYYY-MM-DD, when the provider reports an absolute one. */
  publishedAt: z.string().optional(),
  durationSeconds: z.number().nullish(),
  channelUrl: z.string().nullish(),
  viewCount: z.number().nullish(),
});

export type SearchItem = z.infer<typeof searchItem>;

/** `provider` answered; `attempts` says what happened to each provider tried or skipped before it. */
export const successfulSearch = z.object({
  success: z.literal(true),
  provider: z.string(),
  attempts: z.array(z.string()),
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
};

export type ProviderKind = "api" | "mcp" | "public" | "scrape" | "local";

export type Provider = {
  kind: ProviderKind;
  env?: string;
  supports?: (filters: SearchFilters) => boolean;
  search: (query: string, ctx: SearchContext) => Promise<SearchItem[]>;
};
