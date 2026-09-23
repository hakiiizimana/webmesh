import { z } from "zod";
import type { SearchFilters, SearchItem } from "../types";
import type { Get } from "../types";
import { dateRange, items, onlyFilters, quoteQuery } from "./shared";

// Trims the payload from tens of KB per work down to the fields we actually show.
const SELECT = "id,doi,title,display_name,publication_date,primary_location,cited_by_count,abstract_inverted_index";

const openalexWork = z.object({
  id: z.string(),
  doi: z.string().nullish(),
  title: z.string().nullish(),
  display_name: z.string().nullish(),
  publication_date: z.string().nullish(),
  cited_by_count: z.number().nullish(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullish(),
  primary_location: z
    .object({
      landing_page_url: z.string().nullish(),
      source: z.object({ display_name: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

const openalexResponse = z.object({ results: z.array(openalexWork) });

// OpenAlex ships abstracts as word -> positions, so rebuild the sentence by sorting positions.
function abstractFrom(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  return Object.entries(index)
    .flatMap(([word, positions]) => positions.map((position) => [position, word] as const))
    .sort((a, b) => a[0] - b[0])
    .map(([, word]) => word)
    .join(" ");
}

function openalexSummary(work: z.infer<typeof openalexWork>): string {
  const abstract = abstractFrom(work.abstract_inverted_index);
  if (abstract) return abstract;
  return [work.cited_by_count != null ? `${work.cited_by_count} citations` : "", work.primary_location?.source?.display_name ?? ""]
    .filter(Boolean)
    .join(" · ");
}

export const parseOpenalex = (_query: string, body: string): SearchItem[] => {
  const res = openalexResponse.parse(JSON.parse(body));
  return items(
    res.results.map((work) => ({
      title: work.title || work.display_name,
      url: work.primary_location?.landing_page_url || work.doi || work.id,
      description: openalexSummary(work),
      publishedAt: work.publication_date,
    })),
  );
};

function openalexSupports(filters: SearchFilters): boolean {
  return (
    onlyFilters("freshness", "language", "exactMatch", "type")(filters) &&
    (filters.type === undefined || filters.type === "web")
  );
}

function openalexUrl(query: string, limit: number, filters: SearchFilters): string {
  const params = new URLSearchParams({
    search: filters.exactMatch ? quoteQuery(query) : query,
    per_page: String(Math.min(limit, 100)),
    select: SELECT,
  });
  const range = dateRange(filters.freshness);
  const clauses = [
    range ? `from_publication_date:${range.from}` : "",
    range?.to ? `to_publication_date:${range.to}` : "",
    filters.language ? `language:${filters.language}` : "",
  ].filter(Boolean);
  if (clauses.length > 0) params.set("filter", clauses.join(","));
  return `https://api.openalex.org/works?${params}`;
}

export const openalex = {
  kind: "public",
  method: "GET",
  url: openalexUrl,
  parse: parseOpenalex,
  supports: openalexSupports,
  manual: true,
} satisfies Get;
