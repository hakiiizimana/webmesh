import { z } from "zod";
import { request } from "../../http";
import { publishedDate } from "../../shared/date";
import type { FetchedPage, FetchContext } from "../types";
import { assertPageStatus, normalizePage, withBearer } from "./page";

const jinaResponse = z.object({
  data: z.object({
    url: z.string(),
    title: z.string().nullish(),
    content: z.string().optional(),
    html: z.string().optional(),
    publishedTime: z.string().nullish(),
    httpStatus: z.number().nullish(),
  }),
});

export function pageFromJina(body: string): FetchedPage {
  const { data } = jinaResponse.parse(JSON.parse(body));
  assertPageStatus(data.httpStatus);
  return {
    url: data.url,
    title: data.title || data.url,
    content: data.content ?? data.html ?? "",
    publishedAt: publishedDate(data.publishedTime),
  };
}

export async function fetchJina(url: string, { format, signal, key }: FetchContext): Promise<FetchedPage> {
  const headers = withBearer({ accept: "application/json", "x-return-format": format }, key);
  const res = await request(`https://r.jina.ai/${url}`, { signal, headers });
  return normalizePage(pageFromJina(await res.text()), format);
}
