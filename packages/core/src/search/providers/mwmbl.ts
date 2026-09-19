import { z } from "zod";
import type { SearchItem } from "../types";
import type { Get } from "../types";
import { items, noFilters } from "./shared";

const fragments = z.array(z.object({ value: z.string() }));
const join = (parts: z.infer<typeof fragments>) => parts.map((p) => p.value).join("").trim();

const mwmblResponse = z.array(z.object({ url: z.string(), title: fragments, extract: fragments }));

export const parseMwmbl = (_query: string, body: string): SearchItem[] => {
  const res = mwmblResponse.parse(JSON.parse(body));
  return items(res.map((r) => ({ title: join(r.title) || r.url, url: r.url, description: join(r.extract) })));
};

export const mwmbl = {
  kind: "public",
  method: "GET",
  url: (query) => `https://api.mwmbl.org/api/v1/search/?${new URLSearchParams({ s: query })}`,
  parse: parseMwmbl,
  supports: noFilters,
} satisfies Get;
