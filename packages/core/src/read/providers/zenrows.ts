import { request } from "../../http";
import type { FetchedPage, FetchContext } from "../types";
import { normalizePage } from "./page";

const ENDPOINT = "https://api.zenrows.com/v1/";

// ZenRows answers with the converted page itself, not a JSON envelope.
export function pageFromZenRows(body: string, fallbackUrl: string, finalUrl?: string | null): FetchedPage {
  const content = body.trim();
  return {
    url: finalUrl || fallbackUrl,
    title: content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackUrl,
    content,
  };
}

// `mode=auto` starts on the cheapest configuration and escalates to JS rendering or residential
// proxies only when the site needs it, so the same fetcher covers plain and protected pages.
export async function fetchZenRows(url: string, { format, signal, key }: FetchContext): Promise<FetchedPage> {
  const params = new URLSearchParams({ apikey: key, url, mode: "auto", response_type: format });
  const res = await request(`${ENDPOINT}?${params}`, { signal });
  return normalizePage(pageFromZenRows(await res.text(), url, res.headers.get("zr-final-url")), format);
}
