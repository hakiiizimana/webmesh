import { z } from "zod";
import { request } from "../../http";
import { publishedDate } from "../../shared/date";
import type { FetchedPage, FetchContext, PageFormat } from "../types";
import { assertPageStatus, normalizePage, withBearer } from "./page";

const firecrawlResponse = z.object({
  data: z.object({
    markdown: z.string().optional(),
    html: z.string().optional(),
    metadata: z
      .object({
        title: z.string().optional(),
        publishedTime: z.string().optional(),
        statusCode: z.number().optional(),
      })
      .optional(),
  }),
});

export function pageFromFirecrawl(body: string, url: string, format: PageFormat): FetchedPage {
  const { data } = firecrawlResponse.parse(JSON.parse(body));
  assertPageStatus(data.metadata?.statusCode);
  return {
    url,
    title: data.metadata?.title || url,
    content: (format === "markdown" ? data.markdown : data.html) ?? "",
    publishedAt: publishedDate(data.metadata?.publishedTime),
  };
}

export async function fetchFirecrawl(url: string, { format, signal, key }: FetchContext): Promise<FetchedPage> {
  const headers = withBearer({ "content-type": "application/json", accept: "application/json" }, key);
  const res = await request("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers,
    body: JSON.stringify({ url, formats: [format], onlyMainContent: true }),
    signal,
  });
  return normalizePage(pageFromFirecrawl(await res.text(), url, format), format);
}
