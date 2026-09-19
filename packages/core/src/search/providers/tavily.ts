import { z } from "zod";
import type { Json } from "../../http";
import type { SearchFilters, SearchItem } from "../types";
import type { Post } from "../types";
import { addJsonField, countryName, isFreshnessRange, items, onlyFilters } from "./shared";

const tavilyResponse = z.object({
  results: z.array(
    z.object({ title: z.string(), url: z.string(), content: z.string(), published_date: z.string().nullish() }),
  ),
});

export const parseTavily = (_query: string, body: string): SearchItem[] => {
  const res = tavilyResponse.parse(JSON.parse(body));
  return items(
    res.results.map((r) => ({ title: r.title, url: r.url, description: r.content, publishedAt: r.published_date })),
  );
};

function tavilySupports(filters: SearchFilters): boolean {
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
      "searchDepth",
    )(filters) && (filters.type === undefined || filters.type === "web" || filters.type === "news")
  );
}

function tavilyBody(query: string, limit: number, filters: SearchFilters): Json {
  const body = {
    query,
    max_results: limit,
  };
  addJsonField(body, "search_depth", filters.searchDepth ? (filters.searchDepth === "deep" ? "advanced" : "basic") : undefined);
  addJsonField(body, "topic", filters.type ? (filters.type === "news" ? "news" : "general") : undefined);
  if (filters.freshness !== undefined) {
    if (isFreshnessRange(filters.freshness)) {
      addJsonField(body, "start_date", filters.freshness.from);
      addJsonField(body, "end_date", filters.freshness.to);
      addJsonField(body, "filter_by_published_date", true);
    } else {
      addJsonField(body, "time_range", filters.freshness);
    }
  }
  addJsonField(body, "include_domains", filters.includeDomains?.length ? filters.includeDomains : undefined);
  addJsonField(body, "exclude_domains", filters.excludeDomains?.length ? filters.excludeDomains : undefined);
  addJsonField(body, "country", filters.country ? countryName(filters.country) : undefined);
  if (filters.language) {
    addJsonField(body, "language", filters.language);
    addJsonField(body, "filter_by_language", true);
  }
  addJsonField(body, "safe_search", filters.safeSearch ? filters.safeSearch !== "off" : undefined);
  addJsonField(body, "exact_match", filters.exactMatch);
  return body;
}

export const tavily = {
  kind: "api",
  env: "TAVILY_API_KEY",
  method: "POST",
  url: () => "https://api.tavily.com/search",
  parse: parseTavily,
  headers: (key) => ({ authorization: `Bearer ${key}` }),
  body: tavilyBody,
  supports: tavilySupports,
} satisfies Post;
