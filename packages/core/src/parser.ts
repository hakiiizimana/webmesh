import { z } from "zod";
import { clean, scrapeResults } from "./html";
import type { SearchItem } from "./types";

const hit = z.object({ title: z.string().nullish(), url: z.string(), description: z.string().optional() });
const items = (rows: z.infer<typeof hit>[]): SearchItem[] =>
  rows.map((r) => ({ title: r.title || r.url, url: r.url, description: r.description ?? "" }));

const parallelResponse = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().nullish(), excerpts: z.array(z.string()).optional() })),
});
const exaResponse = z.object({
  results: z.array(z.object({ title: z.string().nullish(), url: z.string(), highlights: z.array(z.string()).optional() })),
});
const keenableResponse = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().optional(), snippet: z.string().optional() })),
});
const fragments = z.array(z.object({ value: z.string() }));
const mwmblResponse = z.array(z.object({ url: z.string(), title: fragments, extract: fragments }));
const join = (parts: z.infer<typeof fragments>) => parts.map((p) => p.value).join("").trim();
const tavilyResponse = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })),
});
const firecrawlResponse = z.object({
  data: z.object({ web: z.array(z.object({ url: z.string(), title: z.string().optional(), description: z.string().optional() })).optional() }),
});
const braveResponse = z.object({
  web: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().optional() })) }).optional(),
});

const snippet = 'div.snippet[data-type="web"]';

export const parsers = {
  parallel: (_query: string, body: string) => {
    const res = parallelResponse.parse(JSON.parse(body));
    return items(res.results.map((r) => ({ title: r.title, url: r.url, description: (r.excerpts ?? []).join(" … ") })));
  },
  exa: (_query: string, body: string) => {
    const res = exaResponse.parse(JSON.parse(body));
    return items(res.results.map((r) => ({ title: r.title, url: r.url, description: (r.highlights ?? []).join(" … ") })));
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
    return items(res.results.map((r) => ({ title: r.title, url: r.url, description: r.content })));
  },
  firecrawl: (_query: string, body: string) => {
    const res = firecrawlResponse.parse(JSON.parse(body));
    return items((res.data.web ?? []).map((r) => ({ title: r.title, url: r.url, description: r.description })));
  },
  brave: (_query: string, body: string) => {
    const res = braveResponse.parse(JSON.parse(body));
    return (res.web?.results ?? []).map((r) => ({ title: clean(r.title), url: r.url, description: clean(r.description ?? "") }));
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
