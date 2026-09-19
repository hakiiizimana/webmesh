import { scrapeResults } from "../../html";
import type { SearchFilters } from "../types";
import type { Scrape } from "../types";
import { isFreshnessRange, onlyFilters, presetFreshness, queryWithOperators } from "./shared";

const DUCKDUCKGO_FRESHNESS = { day: "d", week: "w", month: "m", year: "y" } as const;
const DUCKDUCKGO_SAFE_SEARCH = { strict: "1", moderate: "-1", off: "-2" } as const;

function duckduckgoParams(query: string, filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams({ q: queryWithOperators(query, filters, true) });
  if (filters.freshness !== undefined && !isFreshnessRange(filters.freshness)) {
    params.set("df", DUCKDUCKGO_FRESHNESS[filters.freshness]);
  }
  if (filters.safeSearch) params.set("kp", DUCKDUCKGO_SAFE_SEARCH[filters.safeSearch]);
  return params;
}

function duckduckgoSupports(filters: SearchFilters): boolean {
  return (
    onlyFilters("freshness", "includeDomains", "excludeDomains", "exactMatch", "safeSearch")(filters) &&
    presetFreshness(filters)
  );
}

export const parseDuckduckgoHtml = (query: string, body: string) =>
  scrapeResults(query, body, {
    start: "div.web-result",
    link: "div.web-result a.result__a",
    title: "div.web-result a.result__a",
    description: "div.web-result .result__snippet",
  });

export const parseDuckduckgoLite = (query: string, body: string) =>
  scrapeResults(query, body, {
    start: "a.result-link",
    link: "a.result-link",
    title: "a.result-link",
    description: "td.result-snippet",
  });

export const duckduckgoHtml = {
  kind: "scrape",
  url: (query, filters) => `https://html.duckduckgo.com/html/?${duckduckgoParams(query, filters)}`,
  parse: parseDuckduckgoHtml,
  headers: {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    cookie: "kl=us-en",
  },
  supports: duckduckgoSupports,
} satisfies Scrape;

export const duckduckgoLite = {
  kind: "scrape",
  url: (query, filters) => `https://lite.duckduckgo.com/lite/?${duckduckgoParams(query, filters)}`,
  parse: parseDuckduckgoLite,
  supports: duckduckgoSupports,
} satisfies Scrape;
