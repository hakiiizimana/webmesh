import { z } from "zod";
import type { Json } from "../http";
import type { ResolveAddresses } from "../network";
import type { ProviderKind } from "../shared/provider-kind";
import { ytDlpMetadata, type YtDlpMetadata } from "./providers/ytDlp";

export const fetchFormat = z.enum(["markdown", "html", "rawHtml", "links", "json"]);
export type FetchFormat = z.infer<typeof fetchFormat>;
export const pageFormat = fetchFormat.extract(["markdown", "html"]);
export type PageFormat = z.infer<typeof pageFormat>;

const pageMetadata = z.object({
  sourceURL: z.string(),
  url: z.string(),
  title: z.string(),
  fetchedAt: z.string(),
  contentHash: z.string(),
  publishedAt: z.string().optional(),
  language: z.string().optional(),
  statusCode: z.number().optional(),
  contentType: z.string().optional(),
  scrapeId: z.string().optional(),
  cachedAt: z.string().optional(),
  cacheState: z.string().optional(),
});

export type PageMetadata = z.infer<typeof pageMetadata>;

// What a fetch returns. The cache and the MCP output schema check against this same shape.
export const page = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  format: pageFormat,
  truncated: z.boolean(),
  metadata: pageMetadata,
  publishedAt: z.string().optional(),
  rawHtml: z.string().optional(),
  links: z.array(z.string()).optional(),
  json: z.json().optional(),
  media: ytDlpMetadata.optional(),
});

export type Page = z.infer<typeof page>;

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
  allowPrivateHosts?: readonly string[];
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

export type FetchResult = { success: true; data: Page } | { success: false; error: string };
