import type { ProviderSpec } from "../types";
import { brave, braveWeb } from "./brave";
import { duckduckgoHtml, duckduckgoLite } from "./duckduckgo";
import { exa, exaMcp } from "./exa";
import { firecrawl, firecrawlFree } from "./firecrawl";
import { hnAlgolia } from "./hnAlgolia";
import { keenable, keenablePublic } from "./keenable";
import { marginalia, marginaliaPublic } from "./marginalia";
import { mwmbl } from "./mwmbl";
import { openalex } from "./openalex";
import { parallel, parallelMcp } from "./parallel";
import { searchx } from "./searchx";
import { stackExchange } from "./stackExchange";
import { tavily, tavilyKeyless } from "./tavily";
import { tinyfish } from "./tinyfish";
import { youtube } from "./youtube";

export const specs = {
  "parallel-mcp": parallelMcp,
  "exa-mcp": exaMcp,
  "keenable-public": keenablePublic,
  "duckduckgo-html": duckduckgoHtml,
  "brave-web": braveWeb,
  mwmbl,
  "marginalia-public": marginaliaPublic,
  "duckduckgo-lite": duckduckgoLite,
  "firecrawl-free": firecrawlFree,
  searchx,
  "tavily-keyless": tavilyKeyless,
  "hn-algolia": hnAlgolia,
  stackexchange: stackExchange,
  openalex,
  exa,
  parallel,
  tavily,
  keenable,
  brave,
  youtube,
  firecrawl,
  marginalia,
  tinyfish,
} satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof specs;

export const isProviderId = (id: string): id is ProviderId => Object.hasOwn(specs, id);

export const providerIds = Object.keys(specs).filter(isProviderId);
