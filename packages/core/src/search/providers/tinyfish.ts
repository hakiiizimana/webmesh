import { z } from "zod";
import type { SearchItem } from "../types";
import type { Get } from "../types";
import { items, noFilters } from "./shared";

const tinyfishResponse = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string().nullish(),
      date: z.string().nullish(),
    }),
  ),
});

export const parseTinyfish = (_query: string, body: string): SearchItem[] => {
  const res = tinyfishResponse.parse(JSON.parse(body));
  return items(
    res.results.map((r) => ({ title: r.title, url: r.url, description: r.snippet ?? "", publishedAt: r.date ?? undefined })),
  );
};

export const tinyfish = {
  kind: "api",
  env: "TINYFISH_API_KEY",
  method: "GET",
  url: (query) => `https://api.search.tinyfish.ai?${new URLSearchParams({ query })}`,
  parse: parseTinyfish,
  headers: (key) => ({ "x-api-key": key }),
  supports: noFilters,
} satisfies Get;
