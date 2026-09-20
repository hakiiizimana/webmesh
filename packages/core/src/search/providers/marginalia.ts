import { z } from "zod";
import type { SearchItem } from "../types";
import type { Get } from "../types";
import { items, noFilters } from "./shared";

const marginaliaResponse = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      description: z.string().nullish(),
    }),
  ),
});

export const parseMarginalia = (_query: string, body: string): SearchItem[] => {
  const res = marginaliaResponse.parse(JSON.parse(body));
  return items(res.results.map((r) => ({ title: r.title, url: r.url, description: r.description ?? "" })));
};

const marginaliaUrl = (query: string, limit: number) =>
  `https://api2.marginalia-search.com/search?${new URLSearchParams({ query, count: String(Math.min(limit, 100)) })}`;

export const marginaliaPublic = {
  kind: "public",
  method: "GET",
  url: marginaliaUrl,
  parse: parseMarginalia,
  headers: () => ({ "api-key": "public" }),
  supports: noFilters,
} satisfies Get;

export const marginalia = {
  kind: "api",
  env: "MARGINALIA_API_KEY",
  method: "GET",
  url: marginaliaUrl,
  parse: parseMarginalia,
  headers: (key) => ({ "api-key": key }),
  supports: noFilters,
} satisfies Get;
