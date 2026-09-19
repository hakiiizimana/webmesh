import type { SearchContext } from "./types";

const CACHE_DEFAULT_TTL_MS = 20 * 60_000;
const CACHE_WEEK_TTL_MS = 60 * 60_000;
const CACHE_LONG_TTL_MS = 24 * 60 * 60_000;

export function cacheTtl(filters: SearchContext["filters"]): number {
  const freshness = filters.freshness;
  switch (freshness) {
    case "week":
      return CACHE_WEEK_TTL_MS;
    case "month":
    case "year":
      return CACHE_LONG_TTL_MS;
    case "day":
      return CACHE_DEFAULT_TTL_MS;
    default:
      return freshness?.to ? CACHE_LONG_TTL_MS : CACHE_DEFAULT_TTL_MS;
  }
}

export function cacheKey(
  query: string,
  limit: number,
  only: readonly string[] | undefined,
  filters: SearchContext["filters"],
): string {
  const freshness = (() => {
    switch (filters.freshness) {
      case "day":
      case "week":
      case "month":
      case "year":
        return filters.freshness;
      default:
        return filters.freshness ? { from: filters.freshness.from, to: filters.freshness.to } : undefined;
    }
  })();

  return JSON.stringify({
    version: 2,
    query: query.trim().replace(/\s+/g, " "),
    limit,
    only: only?.length ? [...only].sort() : undefined,
    filters: {
      freshness,
      includeDomains: filters.includeDomains?.length ? [...filters.includeDomains].sort() : undefined,
      excludeDomains: filters.excludeDomains?.length ? [...filters.excludeDomains].sort() : undefined,
      type: filters.type,
      country: filters.country,
      language: filters.language,
      safeSearch: filters.safeSearch,
      exactMatch: filters.exactMatch === true ? true : undefined,
      searchDepth: filters.searchDepth,
    },
  });
}
