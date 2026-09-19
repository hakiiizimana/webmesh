import { z } from "zod";
import type { Json } from "../../http";
import type { SearchFilters, SearchItem } from "../types";
import type { Mcp, Post } from "../types";
import {
  addJsonField,
  dateEnd,
  dateRange,
  dateStart,
  items,
  noFilters,
  onlyFilters,
  publishedDate,
  queryWithOperators,
} from "./shared";

const exaResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      publishedDate: z.string().nullish(),
      highlights: z.array(z.string()).optional(),
    }),
  ),
});

export const parseExa = (_query: string, body: string): SearchItem[] => {
  const res = exaResponse.parse(JSON.parse(body));
  return items(
    res.results.map((r) => ({
      title: r.title,
      url: r.url,
      description: (r.highlights ?? []).join(" … "),
      publishedAt: r.publishedDate,
    })),
  );
};

export const parseExaMcp = (_query: string, body: string): SearchItem[] =>
  body.split(/\n---\n/).flatMap((block) => {
    const field = (name: string) => block.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim();
    const url = field("URL");
    if (!url) return [];
    const title = field("Title");
    const text = block.split(/^Highlights:\s*$/m)[1] ?? "";
    return [
      {
        title: title && title !== "N/A" ? title : url,
        url,
        description: text.replace(/^\.\.\.$/gm, " ").replace(/^#+\s*/gm, "").trim(),
        publishedAt: publishedDate(field("Published")),
      },
    ];
  });

function exaSupports(filters: SearchFilters): boolean {
  return (
    onlyFilters("freshness", "includeDomains", "excludeDomains", "country", "safeSearch", "exactMatch")(filters) &&
    (filters.type === undefined || filters.type === "web")
  );
}

function exaBody(query: string, limit: number, filters: SearchFilters): Json {
  const range = dateRange(filters.freshness);
  const body = {
    query: queryWithOperators(query, filters),
    numResults: limit,
    type: "auto",
    contents: { highlights: { maxCharacters: 600 } },
  };
  if (range) {
    addJsonField(body, "startPublishedDate", dateStart(range.from));
    addJsonField(body, "endPublishedDate", range.to ? dateEnd(range.to) : undefined);
  }
  addJsonField(body, "includeDomains", filters.includeDomains?.length ? filters.includeDomains : undefined);
  addJsonField(body, "excludeDomains", filters.excludeDomains?.length ? filters.excludeDomains : undefined);
  addJsonField(body, "userLocation", filters.country);
  addJsonField(body, "moderation", filters.safeSearch ? filters.safeSearch !== "off" : undefined);
  return body;
}

export const exa = {
  kind: "api",
  env: "EXA_API_KEY",
  method: "POST",
  url: () => "https://api.exa.ai/search",
  parse: parseExa,
  headers: (key) => ({ authorization: `Bearer ${key}` }),
  body: exaBody,
  supports: exaSupports,
} satisfies Post;

export const exaMcp = {
  kind: "mcp",
  url: "https://mcp.exa.ai/mcp",
  tool: "web_search_exa",
  parse: parseExaMcp,
  args: (query, limit) => ({ query, numResults: limit }),
  supports: noFilters,
} satisfies Mcp;
