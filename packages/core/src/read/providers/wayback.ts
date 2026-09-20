import { request } from "../../http";
import type { FetchedPage, FetchContext } from "../types";
import { normalizePage, pageFromHtml } from "./page";

// Snapshots are stale, so callers must select this fetcher explicitly.
export async function fetchWayback(url: string, { format, signal }: FetchContext): Promise<FetchedPage> {
  const res = await request(`https://web.archive.org/web/${url}`, { signal });
  return normalizePage(await pageFromHtml(await res.text(), url, format), format);
}
