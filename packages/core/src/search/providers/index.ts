import type { ProviderSpec } from "../types";
import { brave, braveWeb } from "./brave";
import { duckduckgoHtml, duckduckgoLite } from "./duckduckgo";
import { exa, exaMcp } from "./exa";
import { firecrawl, firecrawlFree } from "./firecrawl";
import { keenable, keenablePublic } from "./keenable";
import { mwmbl } from "./mwmbl";
import { parallel, parallelMcp } from "./parallel";
import { tavily } from "./tavily";
import { youtube } from "./youtube";

export const specs = {
  "parallel-mcp": parallelMcp,
  "exa-mcp": exaMcp,
  "keenable-public": keenablePublic,
  "duckduckgo-html": duckduckgoHtml,
  "brave-web": braveWeb,
  mwmbl,
  "duckduckgo-lite": duckduckgoLite,
  "firecrawl-free": firecrawlFree,
  exa,
  parallel,
  tavily,
  keenable,
  brave,
  youtube,
  firecrawl,
} satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof specs;

export const isProviderId = (id: string): id is ProviderId => Object.hasOwn(specs, id);
