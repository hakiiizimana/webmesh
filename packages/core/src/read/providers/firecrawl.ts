import { z } from "zod";
import { request } from "../../http";
import { publishedDate } from "../../shared/date";
import type { FetchedPage, FetchContext, PageFormat } from "../types";
import { assertPageStatus, normalizePage, withBearer } from "./page";

const firecrawlResponse = z.object({
  data: z.object({
    markdown: z.string().optional(),
    html: z.string().optional(),
    rawHtml: z.string().optional(),
    links: z.array(z.string()).optional(),
    json: z.json().optional(),
    metadata: z
      .object({
        title: z.string().optional(),
        publishedTime: z.string().optional(),
        statusCode: z.number().optional(),
        sourceURL: z.string().optional(),
        url: z.string().optional(),
        language: z.string().optional(),
        contentType: z.string().optional(),
        scrapeId: z.string().optional(),
        cachedAt: z.string().optional(),
        cacheState: z.string().optional(),
      })
      .optional(),
  }),
});

export function pageFromFirecrawl(body: string, url: string, format: PageFormat): FetchedPage {
  const { data } = firecrawlResponse.parse(JSON.parse(body));
  assertPageStatus(data.metadata?.statusCode);
  return {
    url: data.metadata?.url || url,
    title: data.metadata?.title || url,
    content: (format === "markdown" ? data.markdown ?? data.html : data.html ?? data.rawHtml) ?? "",
    publishedAt: publishedDate(data.metadata?.publishedTime),
    rawHtml: data.rawHtml,
    links: data.links,
    json: data.json,
    metadata: data.metadata
      ? {
          language: data.metadata.language,
          statusCode: data.metadata.statusCode,
          contentType: data.metadata.contentType,
          scrapeId: data.metadata.scrapeId,
          cachedAt: data.metadata.cachedAt,
          cacheState: data.metadata.cacheState,
        }
      : undefined,
  };
}

export async function fetchFirecrawl(url: string, { format, formats, schema, signal, key }: FetchContext): Promise<FetchedPage> {
  const headers = withBearer({ "content-type": "application/json", accept: "application/json" }, key);
  const res = await request("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url,
      formats: formats.map((requested) => (requested === "json" ? { type: "json", schema } : requested)),
      onlyMainContent: !formats.includes("rawHtml"),
    }),
    signal,
  });
  const page = pageFromFirecrawl(await res.text(), url, format);
  const normalized = await normalizePage(page, format);
  return { ...page, ...normalized, rawHtml: page.rawHtml, links: page.links, json: page.json, metadata: page.metadata };
}
