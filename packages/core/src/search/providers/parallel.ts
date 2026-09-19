import { z } from "zod";
import type { Json } from "../../http";
import type { SearchFilters, SearchItem } from "../types";
import type { Mcp, Post } from "../types";
import { addJsonField, dateRange, isFreshnessRange, items, noFilters, onlyFilters, queryWithOperators } from "./shared";

const SESSION = crypto.randomUUID().replaceAll("-", "");

const parallelResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      publish_date: z.string().nullish(),
      excerpts: z.array(z.string()).optional(),
    }),
  ),
});

export const parseParallel = (_query: string, body: string): SearchItem[] => {
  const res = parallelResponse.parse(JSON.parse(body));
  return items(
    res.results.map((r) => ({
      title: r.title,
      url: r.url,
      description: (r.excerpts ?? []).join(" … "),
      publishedAt: r.publish_date,
    })),
  );
};

function parallelSupports(filters: SearchFilters): boolean {
  if (!onlyFilters("freshness", "includeDomains", "excludeDomains", "searchDepth")(filters)) return false;
  if (filters.includeDomains?.length && filters.excludeDomains?.length) return false;
  return filters.freshness === undefined || !isFreshnessRange(filters.freshness) || filters.freshness.to === undefined;
}

function parallelBody(query: string, _limit: number, filters: SearchFilters): Json {
  const range = dateRange(filters.freshness);
  const sourcePolicy = {};
  addJsonField(sourcePolicy, "include_domains", filters.includeDomains?.length ? filters.includeDomains : undefined);
  addJsonField(sourcePolicy, "exclude_domains", filters.excludeDomains?.length ? filters.excludeDomains : undefined);
  addJsonField(sourcePolicy, "after_date", range?.from);
  const body = {
    objective: queryWithOperators(query, filters),
    search_queries: [queryWithOperators(query, filters)],
    mode: filters.searchDepth === "deep" ? "advanced" : "fast",
  };
  if (Object.keys(sourcePolicy).length > 0) addJsonField(body, "advanced_settings", { source_policy: sourcePolicy });
  return body;
}

export const parallelMcp = {
  kind: "mcp",
  url: "https://search.parallel.ai/mcp",
  tool: "web_search",
  parse: parseParallel,
  preferStructured: true,
  args: (query) => ({ objective: query, search_queries: [query], session_id: SESSION }),
  supports: noFilters,
} satisfies Mcp;

export const parallel = {
  kind: "api",
  env: "PARALLEL_API_KEY",
  method: "POST",
  url: () => "https://api.parallel.ai/v1/search",
  parse: parseParallel,
  headers: (key) => ({ "x-api-key": key }),
  body: parallelBody,
  supports: parallelSupports,
} satisfies Post;
