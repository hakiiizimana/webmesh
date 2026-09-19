import { z } from "zod";
import { clean, scrapeResults } from "../../html";
import type { Freshness, SearchFilters, SearchItem } from "../types";
import type { Get, Scrape } from "../types";
import {
  dateOnly,
  isFreshnessRange,
  onlyFilters,
  presetFreshness,
  publishedDate,
  queryWithOperators,
} from "./shared";

function braveFreshness(freshness: Freshness | undefined): string | undefined {
  if (!freshness) return undefined;
  if (!isFreshnessRange(freshness)) return { day: "pd", week: "pw", month: "pm", year: "py" }[freshness];
  return `${freshness.from}to${freshness.to ?? dateOnly(new Date())}`;
}

const braveHit = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  page_age: z.string().optional(),
});

const braveResponse = z.object({
  web: z.object({ results: z.array(braveHit) }).optional(),
  news: z.object({ results: z.array(braveHit) }).optional(),
});

export const parseBrave = (_query: string, body: string): SearchItem[] => {
  const res = braveResponse.parse(JSON.parse(body));
  return [...(res.web?.results ?? []), ...(res.news?.results ?? [])].map((r) => ({
    title: clean(r.title),
    url: r.url,
    description: clean(r.description ?? r.snippet ?? ""),
    publishedAt: publishedDate(r.page_age),
  }));
};

const snippet = 'div.snippet[data-type="web"]';

export const parseBraveWeb = (query: string, body: string) =>
  scrapeResults(query, body, {
    start: snippet,
    link: `${snippet} a[href]`,
    title: `${snippet} div.title`,
    description: `${snippet} div.generic-snippet div.content`,
  });

function braveSupports(filters: SearchFilters): boolean {
  return (
    onlyFilters(
      "freshness",
      "includeDomains",
      "excludeDomains",
      "type",
      "country",
      "language",
      "safeSearch",
      "exactMatch",
    )(filters) && (filters.type === undefined || filters.type === "web" || filters.type === "news")
  );
}

function braveUrl(query: string, limit: number, filters: SearchFilters): string {
  const endpoint = filters.type === "news" ? "news" : "web";
  const params = new URLSearchParams({ q: queryWithOperators(query, filters, true), count: String(Math.min(limit, 20)) });
  const freshness = braveFreshness(filters.freshness);
  if (freshness) params.set("freshness", freshness);
  if (filters.country) params.set("country", filters.country.toUpperCase());
  if (filters.language) params.set("search_lang", filters.language);
  if (filters.safeSearch) params.set("safesearch", filters.safeSearch);
  return `https://api.search.brave.com/res/v1/${endpoint}/search?${params}`;
}

function braveWebSupports(filters: SearchFilters): boolean {
  return onlyFilters("freshness", "includeDomains", "excludeDomains", "exactMatch")(filters) && presetFreshness(filters);
}

function braveWebUrl(query: string, filters: SearchFilters): string {
  const params = new URLSearchParams({ q: queryWithOperators(query, filters, true), source: "web" });
  const freshness = braveFreshness(filters.freshness);
  if (freshness) params.set("tf", freshness);
  return `https://search.brave.com/search?${params}`;
}

export const brave = {
  kind: "api",
  env: "BRAVE_API_KEY",
  method: "GET",
  url: braveUrl,
  parse: parseBrave,
  headers: (key) => ({ "x-subscription-token": key }),
  supports: braveSupports,
} satisfies Get;

export const braveWeb = {
  kind: "scrape",
  url: braveWebUrl,
  parse: parseBraveWeb,
  supports: braveWebSupports,
} satisfies Scrape;
