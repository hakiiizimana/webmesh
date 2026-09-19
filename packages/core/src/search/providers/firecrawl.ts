import { z } from "zod";
import type { Json } from "../../http";
import type { Freshness, SearchFilters, SearchItem } from "../types";
import type { Post } from "../types";
import {
  addJsonField,
  countryName,
  dateOnly,
  isFreshnessRange,
  items,
  onlyFilters,
  queryWithOperators,
} from "./shared";

function firecrawlFreshness(freshness: Freshness | undefined): string | undefined {
  if (!freshness) return undefined;
  if (!isFreshnessRange(freshness)) return { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness];
  const format = (value: string) => {
    const [year, month, day] = value.split("-");
    return `${month}/${day}/${year}`;
  };
  return `cdr:1,cd_min:${format(freshness.from)},cd_max:${format(freshness.to ?? dateOnly(new Date()))}`;
}

const firecrawlHit = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  date: z.string().optional(),
});

const firecrawlResponse = z.object({
  data: z.object({ web: z.array(firecrawlHit).optional(), news: z.array(firecrawlHit).optional() }),
});

export const parseFirecrawl = (_query: string, body: string): SearchItem[] => {
  const res = firecrawlResponse.parse(JSON.parse(body));
  return items(
    [...(res.data.web ?? []), ...(res.data.news ?? [])].map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description ?? r.snippet,
      publishedAt: r.date,
    })),
  );
};

function firecrawlSupports(filters: SearchFilters): boolean {
  if (
    !onlyFilters(
      "freshness",
      "includeDomains",
      "excludeDomains",
      "type",
      "country",
      "safeSearch",
      "exactMatch",
    )(filters)
  )
    return false;
  if (filters.type === "video") return false;
  return !(filters.type === "news" && filters.freshness !== undefined);
}

function firecrawlBody(query: string, limit: number, filters: SearchFilters): Json {
  const bothDomainFilters = Boolean(filters.includeDomains?.length && filters.excludeDomains?.length);
  const body = {
    query: queryWithOperators(query, filters, Boolean(bothDomainFilters)),
    limit,
  };
  addJsonField(body, "sources", filters.type ? [filters.type] : undefined);
  addJsonField(body, "includeDomains", filters.includeDomains?.length && !bothDomainFilters ? filters.includeDomains : undefined);
  addJsonField(body, "excludeDomains", filters.excludeDomains?.length && !bothDomainFilters ? filters.excludeDomains : undefined);
  addJsonField(body, "location", filters.country ? countryName(filters.country) : undefined);
  addJsonField(body, "safe", filters.safeSearch ? filters.safeSearch !== "off" : undefined);
  addJsonField(body, "tbs", firecrawlFreshness(filters.freshness));
  return body;
}

export const firecrawl = {
  kind: "api",
  env: "FIRECRAWL_API_KEY",
  method: "POST",
  url: () => "https://api.firecrawl.dev/v2/search",
  parse: parseFirecrawl,
  headers: (key) => ({ authorization: `Bearer ${key}` }),
  body: firecrawlBody,
  supports: firecrawlSupports,
} satisfies Post;

export const firecrawlFree = {
  kind: "public",
  method: "POST",
  url: () => "https://api.firecrawl.dev/v2/search",
  parse: parseFirecrawl,
  body: firecrawlBody,
  supports: firecrawlSupports,
} satisfies Post;
