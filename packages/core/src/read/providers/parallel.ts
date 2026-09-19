import { z } from "zod";
import { callMcp } from "../../mcp";
import { publishedDate } from "../../shared/date";
import type { FetchedPage, FetchContext } from "../types";
import { normalizePage } from "./page";

const parallelFetchResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      publish_date: z.string().nullish(),
      full_content: z.string().nullish(),
    }),
  ),
});

export function pageFromParallel(body: string, url: string): FetchedPage {
  const page = parallelFetchResponse.parse(JSON.parse(body)).results[0];
  return {
    url: page?.url ?? url,
    title: page?.title || url,
    content: page?.full_content ?? "",
    publishedAt: publishedDate(page?.publish_date),
  };
}

export async function fetchParallelMcp(url: string, { format, signal }: FetchContext): Promise<FetchedPage> {
  const args = { urls: [url], full_content: true };
  return normalizePage(pageFromParallel(await callMcp("https://search.parallel.ai/mcp", "web_fetch", args, signal, true), url), format);
}
