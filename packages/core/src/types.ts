export type SearchItem = {
  title: string;
  url: string;
  description: string;
};

export type SearchResult = { success: true; data: SearchItem[] } | { success: false; error: string };

export type SearchContext = {
  limit: number;
  signal: AbortSignal;
  key: string;
};

export type ProviderKind = "api" | "mcp" | "public" | "scrape";

export type Provider = {
  kind: ProviderKind;
  env?: string;
  search: (query: string, ctx: SearchContext) => Promise<SearchItem[]>;
};
