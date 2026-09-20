import type { Json } from "../http";
import type { ResolveAddresses } from "../network";
import type { ProviderKind } from "../shared/provider-kind";
import type { YtDlpMetadata } from "./providers/ytDlp";

export const fetchFormats = ["markdown", "html", "rawHtml", "links", "json"] as const;
export type FetchFormat = (typeof fetchFormats)[number];
export type PageFormat = Extract<FetchFormat, "markdown" | "html">;

export type PageMetadata = {
  sourceURL: string;
  url: string;
  title: string;
  fetchedAt: string;
  contentHash: string;
  publishedAt?: string;
  language?: string;
  statusCode?: number;
  contentType?: string;
  scrapeId?: string;
  cachedAt?: string;
  cacheState?: string;
};

export type FetchedPage = {
  url: string;
  title: string;
  content: string;
  publishedAt?: string;
  rawHtml?: string;
  links?: string[];
  json?: Json;
  metadata?: Partial<PageMetadata>;
  media?: YtDlpMetadata;
};

export type FetchContext = {
  format: PageFormat;
  formats: readonly FetchFormat[];
  schema?: Json;
  maxCharacters: number;
  signal: AbortSignal;
  key: string;
  proxy?: string;
  allowPrivateNetworks?: boolean;
  resolve?: ResolveAddresses;
};

export type Fetcher = {
  kind: ProviderKind;
  env?: string;
  // Excluded from the default provider pool. Only runs when a caller names it.
  manual?: boolean;
  available?: () => boolean;
  accepts?: (url: string) => boolean;
  formats: readonly FetchFormat[];
  fetch: (url: string, context: FetchContext) => Promise<FetchedPage>;
};

export type Page = Omit<FetchedPage, "metadata"> & { format: PageFormat; truncated: boolean; metadata: PageMetadata };

export type FetchResult = { success: true; data: Page } | { success: false; error: string };
