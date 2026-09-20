import { request } from "../../http";
import { publishedDate } from "../../shared/date";
import type { FetchedPage, FetchContext } from "../types";
import { normalizePage } from "./page";

const CONTENT_MARKER = "Markdown Content:";

// Fields are optional and unordered, so parse the preamble by name.
export function pageFromMarkdownNew(body: string, fallbackUrl: string): FetchedPage {
  const at = body.indexOf(CONTENT_MARKER);
  const preamble = at === -1 ? "" : body.slice(0, at);
  const content = at === -1 ? body.trim() : body.slice(at + CONTENT_MARKER.length).trim();
  const field = (name: string) => preamble.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const title = field("Title");
  return {
    url: field("URL Source") ?? fallbackUrl,
    title: title || fallbackUrl,
    content,
    publishedAt: publishedDate(field("Published Time")),
  };
}

export async function fetchMarkdownNew(url: string, { signal }: FetchContext): Promise<FetchedPage> {
  const res = await request(`https://markdown.new/${url}`, { signal, headers: { accept: "text/markdown" } });
  return normalizePage(pageFromMarkdownNew(await res.text(), url), "markdown");
}
