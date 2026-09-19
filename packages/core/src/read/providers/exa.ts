import { callMcp } from "../../mcp";
import type { FetchedPage, FetchContext } from "../types";
import { normalizePage } from "./page";

export function pageFromExa(text: string, url: string): FetchedPage {
  const title = text.match(/^# (.*)$/m)?.[1]?.trim();
  const content = text.replace(/^# .*\n(?:URL: .*\n)?/, "").trim();
  return { url, title: title || url, content };
}

export async function fetchExaMcp(url: string, { format, maxCharacters, signal }: FetchContext): Promise<FetchedPage> {
  // One extra character tells a cut page apart from one that fit.
  const args = { urls: [url], maxCharacters: maxCharacters + 1 };
  return normalizePage(pageFromExa(await callMcp("https://mcp.exa.ai/mcp", "web_fetch_exa", args, signal, false), url), format);
}
