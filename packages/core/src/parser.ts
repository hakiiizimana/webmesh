import { z } from "zod";
import { clean, scrapeResults } from "./html";
import type { SearchItem } from "./types";

/** Normalizes a provider's publish date to YYYY-MM-DD. Relative dates like "1 week ago" are dropped. */
export function publishedDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const hit = z.object({
  title: z.string().nullish(),
  url: z.string(),
  description: z.string().optional(),
  publishedAt: z.string().nullish(),
});
const items = (rows: z.infer<typeof hit>[]): SearchItem[] =>
  rows.map((r) => ({
    title: r.title || r.url,
    url: r.url,
    description: r.description ?? "",
    publishedAt: publishedDate(r.publishedAt),
  }));

const parallelResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      publish_date: z.string().nullish(),
      excerpts: z.array(z.string()).optional(),
    }),
  ),
});
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
const keenableResponse = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().optional(), snippet: z.string().optional() })),
});
const fragments = z.array(z.object({ value: z.string() }));
const mwmblResponse = z.array(z.object({ url: z.string(), title: fragments, extract: fragments }));
const join = (parts: z.infer<typeof fragments>) => parts.map((p) => p.value).join("").trim();
const tavilyResponse = z.object({
  results: z.array(
    z.object({ title: z.string(), url: z.string(), content: z.string(), published_date: z.string().nullish() }),
  ),
});
const firecrawlHit = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  date: z.string().optional(),
});
const firecrawlResponse = z.object({
  data: z.object({ web: z.array(firecrawlHit).optional(), news: z.array(firecrawlHit).optional() }),
});
const braveHit = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  page_age: z.string().optional(),
});
const braveResponse = z.object({
  web: z.object({ results: z.array(braveHit) }).optional(),
  news: z.object({ results: z.array(braveHit) }).optional(),
});

const snippet = 'div.snippet[data-type="web"]';

export const parsers = {
  parallel: (_query: string, body: string) => {
    const res = parallelResponse.parse(JSON.parse(body));
    return items(
      res.results.map((r) => ({
        title: r.title,
        url: r.url,
        description: (r.excerpts ?? []).join(" … "),
        publishedAt: r.publish_date,
      })),
    );
  },
  exa: (_query: string, body: string) => {
    const res = exaResponse.parse(JSON.parse(body));
    return items(
      res.results.map((r) => ({
        title: r.title,
        url: r.url,
        description: (r.highlights ?? []).join(" … "),
        publishedAt: r.publishedDate,
      })),
    );
  },
  "exa-mcp": (_query: string, body: string) =>
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
    }),
  keenable: (_query: string, body: string) => {
    const res = keenableResponse.parse(JSON.parse(body));
    return items(res.results.map((r) => ({ title: r.title, url: r.url, description: r.snippet || r.description || "" })));
  },
  mwmbl: (_query: string, body: string) => {
    const res = mwmblResponse.parse(JSON.parse(body));
    return items(res.map((r) => ({ title: join(r.title) || r.url, url: r.url, description: join(r.extract) })));
  },
  tavily: (_query: string, body: string) => {
    const res = tavilyResponse.parse(JSON.parse(body));
    return items(
      res.results.map((r) => ({ title: r.title, url: r.url, description: r.content, publishedAt: r.published_date })),
    );
  },
  firecrawl: (_query: string, body: string) => {
    const res = firecrawlResponse.parse(JSON.parse(body));
    return items([...(res.data.web ?? []), ...(res.data.news ?? [])].map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description ?? r.snippet,
      publishedAt: r.date,
    })));
  },
  brave: (_query: string, body: string) => {
    const res = braveResponse.parse(JSON.parse(body));
    return [...(res.web?.results ?? []), ...(res.news?.results ?? [])].map((r) => ({
      title: clean(r.title),
      url: r.url,
      description: clean(r.description ?? r.snippet ?? ""),
      publishedAt: publishedDate(r.page_age),
    }));
  },
  "brave-web": (query: string, body: string) =>
    scrapeResults(query, body, {
      start: snippet,
      link: `${snippet} a[href]`,
      title: `${snippet} div.title`,
      description: `${snippet} div.generic-snippet div.content`,
    }),
  "duckduckgo-html": (query: string, body: string) =>
    scrapeResults(query, body, {
      start: "div.web-result",
      link: "div.web-result a.result__a",
      title: "div.web-result a.result__a",
      description: "div.web-result .result__snippet",
    }),
  "duckduckgo-lite": (query: string, body: string) =>
    scrapeResults(query, body, {
      start: "a.result-link",
      link: "a.result-link",
      title: "a.result-link",
      description: "td.result-snippet",
    }),
};

export type ParserId = keyof typeof parsers;

export const parse = (id: ParserId, query: string, body: string) => parsers[id](query, body);
