import { z } from "zod";
import type { SearchItem } from "../types";
import type { Post } from "../types";
import { items, noFilters } from "./shared";

const keenableBody = (query: string, limit: number) => ({ query, max_results: Math.min(limit, 50) });

const keenableResponse = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      description: z.string().optional(),
      snippet: z.string().optional(),
    }),
  ),
});

export const parseKeenable = (_query: string, body: string): SearchItem[] => {
  const res = keenableResponse.parse(JSON.parse(body));
  return items(
    res.results.map((r) => ({ title: r.title, url: r.url, description: r.snippet || r.description || "" })),
  );
};

export const keenable = {
  kind: "api",
  env: "KEENABLE_API_KEY",
  method: "POST",
  url: () => "https://api.keenable.ai/v1/search",
  parse: parseKeenable,
  headers: (key) => ({ "x-api-key": key }),
  body: keenableBody,
  supports: noFilters,
} satisfies Post;

export const keenablePublic = {
  kind: "public",
  method: "POST",
  url: () => "https://api.keenable.ai/v1/search/public",
  parse: parseKeenable,
  headers: () => ({ "x-keenable-title": "webmesh" }),
  body: keenableBody,
  supports: noFilters,
} satisfies Post;
