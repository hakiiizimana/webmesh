import { z } from "zod";
import { clean } from "../../html";
import type { SearchFilters, SearchItem } from "../types";
import type { Get } from "../types";
import { dateEnd, dateOnly, dateRange, dateStart, items, onlyFilters } from "./shared";

const SITE = "stackoverflow";
const MAX_SNIPPET = 400;

const seItem = z.object({
  question_id: z.number(),
  title: z.string(),
  link: z.string(),
  body: z.string().nullish(),
  is_answered: z.boolean().nullish(),
  score: z.number().nullish(),
  answer_count: z.number().nullish(),
  tags: z.array(z.string()).optional(),
  creation_date: z.number().nullish(),
});

const seResponse = z.object({
  items: z.array(seItem),
  // Set when the caller has been hitting the API too hard.
  backoff: z.number().nullish(),
});

function seSummary(item: z.infer<typeof seItem>): string {
  const answers = item.answer_count ?? 0;
  const stats = [
    item.is_answered ? "answered" : "unanswered",
    item.score != null ? `${item.score} votes` : "",
    `${answers} answer${answers === 1 ? "" : "s"}`,
    item.tags?.join(", ") ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  const body = clean(item.body ?? "").slice(0, MAX_SNIPPET);
  return body ? `${stats} — ${body}` : stats;
}

export const parseStackExchange = (_query: string, body: string): SearchItem[] => {
  const res = seResponse.parse(JSON.parse(body));
  // The docs require a client that reads `backoff` to wait before repeating the call.
  // Failing here lets the router bench this provider instead of hammering it.
  if (res.backoff) throw new Error(`Stack Exchange asked for a ${res.backoff}s backoff`);
  return items(
    res.items.map((item) => ({
      title: item.title,
      url: item.link,
      description: seSummary(item),
      publishedAt: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : undefined,
    })),
  );
};

function seSupports(filters: SearchFilters): boolean {
  return onlyFilters("freshness", "type")(filters) && (filters.type === undefined || filters.type === "web");
}

function seUrl(query: string, limit: number, filters: SearchFilters): string {
  const params = new URLSearchParams({
    order: "desc",
    sort: "relevance",
    q: query,
    site: SITE,
    pagesize: String(Math.min(limit, 100)),
    filter: "withbody",
  });
  const range = dateRange(filters.freshness);
  if (range) {
    const epoch = (day: string, endOfDay: boolean) =>
      Math.floor(Date.parse(endOfDay ? dateEnd(day) : dateStart(day)) / 1000);
    params.set("fromdate", String(epoch(range.from, false)));
    params.set("todate", String(epoch(range.to ?? dateOnly(new Date()), true)));
  }
  return `https://api.stackexchange.com/2.3/search/advanced?${params}`;
}

export const stackExchange = {
  kind: "public",
  method: "GET",
  url: seUrl,
  parse: parseStackExchange,
  supports: seSupports,
  manual: true,
} satisfies Get;
