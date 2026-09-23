import { z } from "zod";
import { clean } from "../../html";
import type { SearchFilters, SearchItem } from "../types";
import type { Get } from "../types";
import { dateEnd, dateOnly, dateRange, dateStart, items, onlyFilters, quoteQuery } from "./shared";

const hnHit = z.object({
  objectID: z.string(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  story_text: z.string().nullish(),
  created_at: z.string().nullish(),
  points: z.number().nullish(),
  num_comments: z.number().nullish(),
  author: z.string().nullish(),
});

const hnResponse = z.object({ hits: z.array(hnHit) });

// Ask HN and Show HN stories carry no url, so they link back to the thread.
const hnThread = (id: string) => `https://news.ycombinator.com/item?id=${id}`;

function hnSummary(hit: z.infer<typeof hnHit>): string {
  return [
    hit.points != null ? `${hit.points} points` : "",
    hit.num_comments != null ? `${hit.num_comments} comments` : "",
    hit.author ? `by ${hit.author}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export const parseHnAlgolia = (_query: string, body: string): SearchItem[] => {
  const res = hnResponse.parse(JSON.parse(body));
  return items(
    res.hits.map((hit) => ({
      title: hit.title,
      url: hit.url || hnThread(hit.objectID),
      description: clean(hit.story_text ?? "") || hnSummary(hit),
      publishedAt: hit.created_at,
    })),
  );
};

function hnAlgoliaSupports(filters: SearchFilters): boolean {
  return onlyFilters("freshness", "exactMatch", "type")(filters) && (filters.type === undefined || filters.type === "web");
}

function hnAlgoliaUrl(query: string, limit: number, filters: SearchFilters): string {
  const params = new URLSearchParams({
    query: filters.exactMatch ? quoteQuery(query) : query,
    tags: "story",
    hitsPerPage: String(Math.min(limit, 50)),
  });
  const range = dateRange(filters.freshness);
  if (range) {
    const epoch = (day: string, endOfDay: boolean) =>
      Math.floor(Date.parse(endOfDay ? dateEnd(day) : dateStart(day)) / 1000);
    const to = epoch(range.to ?? dateOnly(new Date()), true);
    params.set("numericFilters", `created_at_i>${epoch(range.from, false)},created_at_i<${to}`);
  }
  return `https://hn.algolia.com/api/v1/search?${params}`;
}

export const hnAlgolia = {
  kind: "public",
  method: "GET",
  url: hnAlgoliaUrl,
  parse: parseHnAlgolia,
  supports: hnAlgoliaSupports,
  manual: true,
} satisfies Get;
