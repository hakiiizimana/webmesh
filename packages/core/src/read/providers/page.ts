import { Defuddle } from "defuddle/node";
import { clean } from "../../html";
import { publishedDate } from "../../shared/date";
import { TargetError } from "../../router";
import type { FetchedPage, PageFormat } from "../types";
import { cleanHtml } from "./cleanHtml";
import { convertHtmlToMarkdown } from "./htmlToMarkdown";

export const MIN_WORDS = 5;
const JS_SHELL_WORDS = 50;
const JS_SHELL = /enable javascript|requires javascript|javascript is (?:required|disabled)|turn on javascript/i;
const BLOCK_PAGE =
  /just a moment|attention required|checking your browser before|verify you are human|enable javascript and cookies|unusual traffic from your|cf-browser-verification|ddos protection by cloudflare|please complete the security check|you have been blocked/i;
const PUBLISHED_META = /(?:article:published_time|datePublished|og:published_time|article:modified_time|dateModified)/i;
const META_TAG = /<meta\b[^>]*>/gi;

export const withBearer = <T extends Record<string, string>>(headers: T, key: string) =>
  key ? { ...headers, authorization: `Bearer ${key}` } : headers;

// Readers answer 200 even when the page itself failed.
export function assertPageStatus(status: number | null | undefined): void {
  if (status != null && status >= 400) throw new TargetError(`page returned HTTP ${status}`);
}

export function assertReadable(text: string): void {
  if (BLOCK_PAGE.test(text)) throw new TargetError("blocked by an anti-bot page");
}

function looksLikeHtml(content: string): boolean {
  const head = content.trimStart();
  return /^<!doctype\s+html|^<html[\s>]|^<(?:body|div|article|main|section|p|span|table|pre|ul|ol|h[1-6])[\s>]/i.test(head);
}

function wordCount(text: string): number {
  return clean(text).split(/\s+/).filter(Boolean).length;
}

function needsJavaScript(text: string): boolean {
  const words = wordCount(text);
  return words < MIN_WORDS || (words < JS_SHELL_WORDS && JS_SHELL.test(text));
}

function titleFromHtml(html: string, fallback: string): string {
  return clean(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "") || fallback;
}

function publishedFromHtml(html: string): string | undefined {
  for (const tag of html.match(META_TAG) ?? []) {
    if (!PUBLISHED_META.test(tag)) continue;
    const date = publishedDate(/content=["']([^"']*)["']/i.exec(tag)?.[1]);
    if (date) return date;
  }
  return undefined;
}

// Preserve source structure for HTML and use Defuddle for Markdown.
export async function pageFromHtml(html: string, url: string, format: PageFormat): Promise<FetchedPage> {
  if (format === "html") {
    const content = await cleanHtml(html, url);
    if (needsJavaScript(content)) throw new Error("too little content, the page may need JavaScript");
    return { url, title: titleFromHtml(html, url), content, publishedAt: publishedFromHtml(html) };
  }
  const page = await Defuddle(html, url, { markdown: false, separateMarkdown: true });
  if ((page.wordCount ?? 0) < MIN_WORDS || needsJavaScript(page.content)) {
    throw new Error("too little content, the page may need JavaScript");
  }
  const content = await convertHtmlToMarkdown(page.content, page.contentMarkdown ?? "");
  return { url, title: titleFromHtml(html, page.title || url), content, publishedAt: publishedDate(page.published) };
}

export async function normalizePage(page: FetchedPage, format: PageFormat): Promise<FetchedPage> {
  assertReadable(page.content);
  if (!looksLikeHtml(page.content)) return page;
  if (format === "html") return { ...page, content: await cleanHtml(page.content, page.url) };
  try {
    return await pageFromHtml(page.content, page.url, "markdown");
  } catch (err) {
    throw new TargetError(err instanceof Error ? err.message : String(err));
  }
}
