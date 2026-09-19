import { Defuddle } from "defuddle/node";
import { clean } from "../../html";
import { publishedDate } from "../../shared/date";
import { TargetError } from "../../router";
import type { FetchedPage, PageFormat } from "../types";

export const MIN_WORDS = 25;
const BLOCK_PAGE =
  /just a moment|attention required|checking your browser before|verify you are human|enable javascript and cookies|unusual traffic from your|cf-browser-verification|ddos protection by cloudflare|please complete the security check|you have been blocked/i;

export const withBearer = <T extends Record<string, string>>(headers: T, key: string) =>
  key ? { ...headers, authorization: `Bearer ${key}` } : headers;

// Readers answer 200 even when the page itself failed.
export function assertPageStatus(status: number | null | undefined): void {
  if (status != null && status >= 400) throw new TargetError(`page returned HTTP ${status}`);
}

export async function pageFromHtml(html: string, url: string, format: PageFormat): Promise<FetchedPage> {
  const page = await Defuddle(html, url, { markdown: format === "markdown" });
  if ((page.wordCount ?? 0) < MIN_WORDS) throw new Error("too little content, the page may need JavaScript");
  const title = clean(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "") || page.title || url;
  return { url, title, content: page.content, publishedAt: publishedDate(page.published) };
}

export function assertReadable(text: string): void {
  if (BLOCK_PAGE.test(text)) throw new TargetError("blocked by an anti-bot page");
}

function looksLikeHtml(content: string): boolean {
  const head = content.trimStart();
  return /^<!doctype\s+html|^<html[\s>]|^<(?:body|div|article|main|section|p|span|table|pre|ul|ol|h[1-6])[\s>]/i.test(head);
}

export async function normalizePage(page: FetchedPage, format: PageFormat): Promise<FetchedPage> {
  assertReadable(page.content);
  if (format !== "markdown" || !looksLikeHtml(page.content)) return page;
  try {
    return await pageFromHtml(page.content, page.url, "markdown");
  } catch (err) {
    throw new TargetError(err instanceof Error ? err.message : String(err));
  }
}
