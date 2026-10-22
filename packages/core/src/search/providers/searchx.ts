import { z } from "zod";
import type { Freshness, SearchFilters, SearchItem } from "../types";
import type { Get } from "../types";
import { isFreshnessRange, items, onlyFilters, queryWithOperators } from "./shared";

const searchxResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      snippet: z.string().nullish(),
      description: z.string().nullish(),
      published_at: z.string().nullish(),
      publishedAt: z.string().nullish(),
    }),
  ),
});

export const parseSearchX = (_query: string, body: string): SearchItem[] => {
  const res = searchxResponse.parse(JSON.parse(body));
  return items(
    res.results.map((result) => ({
      title: result.title,
      url: result.url,
      description: result.snippet ?? result.description ?? "",
      publishedAt: result.published_at ?? result.publishedAt,
    })),
  );
};

function searchxFreshness(freshness: Freshness | undefined): string | undefined {
  if (!freshness) return undefined;
  if (!isFreshnessRange(freshness)) return freshness;
  return `${freshness.from}..${freshness.to ?? ""}`;
}

function searchxSupports(filters: SearchFilters): boolean {
  return (
    onlyFilters("freshness", "includeDomains", "excludeDomains", "type", "country", "language", "safeSearch", "exactMatch")(filters) &&
    (filters.type === undefined || filters.type === "web" || filters.type === "news" || filters.type === "video")
  );
}

function searchxUrl(query: string, limit: number, filters: SearchFilters): string {
  const params = new URLSearchParams({
    q: queryWithOperators(query, filters, true),
    mode: "hybrid",
    per_page: String(Math.min(limit, 50)),
  });
  const freshness = searchxFreshness(filters.freshness);
  if (freshness) params.set("freshness", freshness);
  if (filters.country) params.set("country", filters.country.toUpperCase());
  if (filters.language) params.set("lang", filters.language);
  if (filters.safeSearch) params.set("safe_search", String(filters.safeSearch !== "off"));
  if (filters.type === "news") params.set("category", "news");
  if (filters.type === "video") params.set("category", "videos");
  return `https://searchx.dev/api/v1/search?${params}`;
}

export const searchx = {
  kind: "public",
  method: "GET",
  url: searchxUrl,
  parse: parseSearchX,
  supports: searchxSupports,
} satisfies Get;
