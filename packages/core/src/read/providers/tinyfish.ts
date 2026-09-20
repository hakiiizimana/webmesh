import { z } from "zod";
import { request } from "../../http";
import { publishedDate } from "../../shared/date";
import type { FetchedPage, FetchContext } from "../types";
import { normalizePage } from "./page";

const tinyfishResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      text: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

export function pageFromTinyfish(body: string, fallbackUrl: string): FetchedPage {
  const result = tinyfishResponse.parse(JSON.parse(body)).results[0];
  if (!result) throw new Error("TinyFish returned no page");
  return {
    url: result.url || fallbackUrl,
    title: result.title || fallbackUrl,
    content: result.text ?? "",
    publishedAt: publishedDate(result.published_date),
  };
}

export async function fetchTinyfish(url: string, { format, signal, key }: FetchContext): Promise<FetchedPage> {
  const res = await request("https://api.fetch.tinyfish.ai", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ urls: [url], format }),
    signal,
  });
  return normalizePage(pageFromTinyfish(await res.text(), url), format);
}
