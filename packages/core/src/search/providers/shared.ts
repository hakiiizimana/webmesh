import { z } from "zod";
import type { Json } from "../../http";
import type { Freshness, FreshnessRange, SearchFilters, SearchItem } from "../types";
import type { FilterSupport } from "../types";
import { publishedDate } from "../../shared/date";
export { publishedDate };

type FilterName = keyof SearchFilters;

const filterNames = [
  "freshness",
  "includeDomains",
  "excludeDomains",
  "type",
  "country",
  "language",
  "safeSearch",
  "exactMatch",
  "searchDepth",
] as const satisfies readonly FilterName[];

function hasFilterValue(value: SearchFilters[FilterName]): boolean {
  if (value === undefined || value === false) return false;
  return !Array.isArray(value) || value.length > 0;
}

export function onlyFilters(...supportedNames: FilterName[]): FilterSupport {
  const supported = new Set(supportedNames);
  return (filters) =>
    !filterNames.some((name) => hasFilterValue(filters[name]) && !supported.has(name));
}

export const noFilters = onlyFilters();

export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateStart(date: string): string {
  return `${date}T00:00:00.000Z`;
}

export function dateEnd(date: string): string {
  return `${date}T23:59:59.999Z`;
}

export function isFreshnessRange(value: Freshness): value is FreshnessRange {
  return Object.hasOwn(Object(value), "from");
}

export function dateRange(freshness: Freshness | undefined): { from: string; to?: string } | undefined {
  if (!freshness) return undefined;
  if (isFreshnessRange(freshness)) return freshness;

  const now = new Date();
  const from = new Date(now);
  const days = { day: 1, week: 7, month: 31, year: 365 }[freshness];
  from.setUTCDate(from.getUTCDate() - days);
  return { from: dateOnly(from), to: dateOnly(now) };
}

export function quoteQuery(query: string): string {
  return `"${query.replaceAll('"', '\\"')}"`;
}

export function queryWithOperators(query: string, filters: SearchFilters, domains = false): string {
  let value = filters.exactMatch ? quoteQuery(query) : query;
  if (!domains) return value;

  const include = filters.includeDomains ?? [];
  const exclude = filters.excludeDomains ?? [];
  if (include.length > 0) value += ` (${include.map((domain) => `site:${domain}`).join(" OR ")})`;
  for (const domain of exclude) value += ` -site:${domain}`;
  return value;
}

export function countryName(country: string): string {
  if (!/^[a-z]{2}$/i.test(country)) return country;
  return new Intl.DisplayNames(["en"], { type: "region" }).of(country.toUpperCase()) ?? country;
}

export function addJsonField<T extends object>(object: T, key: string, value: Json | undefined): void {
  if (value !== undefined) Object.assign(object, { [key]: value });
}

export function presetFreshness(filters: SearchFilters): boolean {
  return filters.freshness === undefined || !isFreshnessRange(filters.freshness);
}

const hit = z.object({
  title: z.string().nullish(),
  url: z.string(),
  description: z.string().optional(),
  publishedAt: z.string().nullish(),
});

export function items(rows: z.infer<typeof hit>[]): SearchItem[] {
  return rows.map((r) => ({
    title: r.title || r.url,
    url: r.url,
    description: r.description ?? "",
    publishedAt: publishedDate(r.publishedAt),
  }));
}
