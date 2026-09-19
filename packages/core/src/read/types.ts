import type { ResolveAddresses } from "../network";
import type { ProviderKind } from "../shared/provider-kind";
import type { YtDlpMetadata } from "./providers/ytDlp";

export type PageFormat = "markdown" | "html";

export type FetchedPage = { url: string; title: string; content: string; publishedAt?: string; media?: YtDlpMetadata };

export type FetchContext = {
  format: PageFormat;
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
  available?: () => boolean;
  accepts?: (url: string) => boolean;
  formats: readonly PageFormat[];
  fetch: (url: string, context: FetchContext) => Promise<FetchedPage>;
};

export type Page = FetchedPage & { format: PageFormat; truncated: boolean };

export type FetchResult = { success: true; data: Page } | { success: false; error: string };
