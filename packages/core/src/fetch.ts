import { Defuddle } from "defuddle/node";
import { extractText } from "unpdf";
import { z } from "zod";
import { agentBrowserPath, createBrowser } from "./browser";
import { clean } from "./html";
import { request } from "./http";
import { callMcp } from "./mcp";
import { blockedUrl, type ResolveAddresses } from "./network";
import { publishedDate } from "./parser";
import { createRouter, type Routed, type RouterOptions, TargetError, usesProxy } from "./router";
import type { ProviderKind } from "./types";
import { defaultYtDlpPath, extractYtDlpMetadata, type YtDlpMetadata } from "./ytDlp";

const BUDGET_MS = 30_000;
const HEDGE_MS = 3_000;
const MAX_CHARACTERS = 50_000;
const MIN_WORDS = 25;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT =
  "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, text/plain;q=0.7, application/pdf;q=0.6, */*;q=0.5";
const BLOCK_PAGE =
  /just a moment|attention required|checking your browser before|verify you are human|enable javascript and cookies|unusual traffic from your|cf-browser-verification|ddos protection by cloudflare|please complete the security check|you have been blocked/i;

export type PageFormat = "markdown" | "html";

export type FetchedPage = { url: string; title: string; content: string; publishedAt?: string; media?: YtDlpMetadata };

export type FetchContext = {
  format: PageFormat;
  maxCharacters: number;
  signal: AbortSignal;
  key: string;
  proxy?: string;
  allowPrivateNetworks?: boolean;
  resolve?: ResolveAddresses;
};

export type Fetcher = {
  kind: ProviderKind;
  env?: string;
  available?: () => boolean;
  accepts?: (url: string) => boolean;
  formats: readonly PageFormat[];
  fetch: (url: string, context: FetchContext) => Promise<FetchedPage>;
};

const SOCIAL_HOSTS = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|reddit\.com|redd\.it|facebook\.com|fb\.watch|vimeo\.com|twitch\.tv|soundcloud\.com)$/i;

const acceptsSocialUrl = (url: string): boolean => {
  const parsed = URL.parse(url);
  return parsed !== null && SOCIAL_HOSTS.test(parsed.hostname);
};

async function fetchSocial(url: string, { signal, proxy }: FetchContext): Promise<FetchedPage> {
  const result = await extractYtDlpMetadata(url, { signal, proxy });
  if (!result.success) throw new TargetError(result.error.message);
  const media = result.data;
  const content = media.description.trim() || media.title;
  return {
    url: media.url,
    title: media.title,
    content,
    ...(media.publishedAt === null ? {} : { publishedAt: media.publishedAt }),
    media,
  };
}

export type Page = FetchedPage & { format: PageFormat; truncated: boolean };

export type FetchResult = Routed<Page>;

const withBearer = <T extends Record<string, string>>(headers: T, key: string) =>
  key ? { ...headers, authorization: `Bearer ${key}` } : headers;

// Readers answer 200 even when the page itself failed.
function assertPageStatus(status: number | null | undefined): void {
  if (status != null && status >= 400) throw new TargetError(`page returned HTTP ${status}`);
}

export async function pageFromHtml(html: string, url: string, format: PageFormat): Promise<FetchedPage> {
  const page = await Defuddle(html, url, { markdown: format === "markdown" });
  if ((page.wordCount ?? 0) < MIN_WORDS) throw new Error("too little content, the page may need JavaScript");
  const title = clean(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "") || page.title || url;
  return { url, title, content: page.content, publishedAt: publishedDate(page.published) };
}

function assertReadable(text: string): void {
  if (BLOCK_PAGE.test(text)) throw new TargetError("blocked by an anti-bot page");
}

function looksLikeHtml(content: string): boolean {
  const head = content.trimStart();
  return /^<!doctype\s+html|^<html[\s>]|^<(?:body|div|article|main|section|p|span|table|pre|ul|ol|h[1-6])[\s>]/i.test(head);
}

function markdownTitle(content: string): string | undefined {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

async function normalizePage(page: FetchedPage, format: PageFormat): Promise<FetchedPage> {
  assertReadable(page.content);
  if (format !== "markdown" || !looksLikeHtml(page.content)) return page;
  try {
    return await pageFromHtml(page.content, page.url, "markdown");
  } catch (err) {
    throw new TargetError(err instanceof Error ? err.message : String(err));
  }
}

const PDF_ERROR = "can't read application/pdf locally";

async function pageFromPdf(bytes: Uint8Array, url: string): Promise<FetchedPage> {
  const parsed = await extractText(bytes, { mergePages: true }).catch(() => undefined);
  const content = parsed?.text.trim() ?? "";
  if (content.split(/\s+/).length < MIN_WORDS) throw new Error(PDF_ERROR);
  return { url, title: url, content };
}

const isPdf = (type: string, target: string) =>
  type.includes("application/pdf") || new URL(target).pathname.toLowerCase().endsWith(".pdf");

async function fetchDirect(
  url: string,
  { format, signal, proxy, allowPrivateNetworks, resolve }: FetchContext,
): Promise<FetchedPage> {
  let target = url;
  let res;
  for (let redirects = 0; ; redirects += 1) {
    if (!allowPrivateNetworks) {
      const error = await blockedUrl(target, resolve);
      if (error) throw new TargetError(error);
    }
    res = await request(target, {
      signal,
      browser: true,
      proxy,
      redirect: "manual",
      headers: { accept: ACCEPT },
    });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location) break;
    if (redirects >= 9) throw new TargetError("too many redirects");
    target = new URL(location, target).href;
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (isPdf(type, target)) return pageFromPdf(await res.bytes(), target);
  const body = await res.text();
  if (type.includes("markdown")) {
    return normalizePage({ url: target, title: markdownTitle(body) || target, content: body }, format);
  }
  assertReadable(body);
  if (type.includes("html")) return pageFromHtml(body, target, format);
  if (type.startsWith("text/") || type.includes("json")) return { url: target, title: target, content: body };
  throw new Error(`can't read ${type || "this content type"} locally`);
}

const openedPage = z.object({ title: z.string().optional(), url: z.string().optional() });
const readPage = z.object({ content: z.string(), status: z.number().nullish() });

async function fetchInBrowser(url: string, { signal, proxy, allowPrivateNetworks }: FetchContext): Promise<FetchedPage> {
  const browser = createBrowser(`webmesh-fetch-${crypto.randomUUID().slice(0, 8)}`, { proxy, allowPrivateNetworks });
  try {
    const opened = await browser.run(["open", url], signal);
    if (!opened.success) throw new Error(opened.error);
    const read = await browser.run(["read"], signal);
    if (!read.success) throw new Error(read.error);
    const page = readPage.parse(read.data);
    assertPageStatus(page.status);
    if (page.content.split(/\s+/).length < MIN_WORDS) throw new Error("too little content after rendering");
    const meta = openedPage.parse(opened.data);
    return { url: meta.url ?? url, title: meta.title || url, content: page.content };
  } finally {
    await browser.close();
  }
}

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

async function fetchJina(url: string, { format, signal, key }: FetchContext): Promise<FetchedPage> {
  const headers = withBearer({ accept: "application/json", "x-return-format": format }, key);
  const res = await request(`https://r.jina.ai/${url}`, { signal, headers });
  return normalizePage(pageFromJina(await res.text()), format);
}

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

async function fetchFirecrawl(url: string, { format, signal, key }: FetchContext): Promise<FetchedPage> {
  const headers = withBearer({ "content-type": "application/json", accept: "application/json" }, key);
  const res = await request("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers,
    body: JSON.stringify({ url, formats: [format], onlyMainContent: true }),
    signal,
  });
  return normalizePage(pageFromFirecrawl(await res.text(), url, format), format);
}

export function pageFromExa(text: string, url: string): FetchedPage {
  const title = text.match(/^# (.*)$/m)?.[1]?.trim();
  const content = text.replace(/^# .*\n(?:URL: .*\n)?/, "").trim();
  return { url, title: title || url, content };
}

async function fetchExaMcp(url: string, { format, maxCharacters, signal }: FetchContext): Promise<FetchedPage> {
  // One extra character tells a cut page apart from one that fit.
  const args = { urls: [url], maxCharacters: maxCharacters + 1 };
  return normalizePage(pageFromExa(await callMcp("https://mcp.exa.ai/mcp", "web_fetch_exa", args, signal, false), url), format);
}

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

async function fetchParallelMcp(url: string, { format, signal }: FetchContext): Promise<FetchedPage> {
  const args = { urls: [url], full_content: true };
  return normalizePage(pageFromParallel(await callMcp("https://search.parallel.ai/mcp", "web_fetch", args, signal, true), url), format);
}

export const fetchers = {
  "yt-dlp": {
    kind: "local",
    available: () => Bun.file(defaultYtDlpPath).size > 0,
    accepts: acceptsSocialUrl,
    formats: ["markdown"],
    fetch: fetchSocial,
  },
  direct: { kind: "local", formats: ["markdown", "html"], fetch: fetchDirect },
  browser: { kind: "browser", available: () => agentBrowserPath() !== null, formats: ["markdown"], fetch: fetchInBrowser },
  "jina-reader": { kind: "public", formats: ["markdown", "html"], fetch: fetchJina },
  "firecrawl-free": { kind: "public", formats: ["markdown", "html"], fetch: fetchFirecrawl },
  "exa-mcp": { kind: "mcp", formats: ["markdown"], fetch: fetchExaMcp },
  "parallel-mcp": { kind: "mcp", formats: ["markdown"], fetch: fetchParallelMcp },
  jina: { kind: "api", env: "JINA_API_KEY", formats: ["markdown", "html"], fetch: fetchJina },
  firecrawl: { kind: "api", env: "FIRECRAWL_API_KEY", formats: ["markdown", "html"], fetch: fetchFirecrawl },
} satisfies Record<string, Fetcher>;

export type FetcherId = keyof typeof fetchers;

export const isFetcherId = (id: string): id is FetcherId => Object.hasOwn(fetchers, id);

type FetchOptions<Id> = { format?: PageFormat; maxCharacters?: number; only?: Id[] };

export function createFetch<R extends Record<string, Fetcher>>(
  registry: R,
  options: RouterOptions & { proxy?: string; allowPrivateNetworks?: boolean; resolve?: ResolveAddresses },
) {
  type Id = keyof R & string;
  const router = createRouter("fetch", registry, options, { budgetMs: BUDGET_MS, hedgeMs: HEDGE_MS });

  async function fetchPage(
    url: string,
    { format = "markdown", maxCharacters = MAX_CHARACTERS, only }: FetchOptions<Id> = {},
  ): Promise<FetchResult> {
    const protocol = URL.parse(url)?.protocol;
    if (protocol !== "https:" && protocol !== "http:") return { success: false, error: "Only http and https URLs can be fetched." };
    if (!options.allowPrivateNetworks) {
      const error = await blockedUrl(url, options.resolve);
      if (error) return { success: false, error };
    }
    const configured = (only ?? router.ids).filter(router.isReady);
    const ready = configured.filter((id) => {
      const fetcher = router.get(id);
      return fetcher.formats.includes(format) && (fetcher.accepts?.(url) ?? true);
    });
    if (ready.length === 0) {
      return {
        success: false,
        error: configured.length === 0 ? "No fetchers configured." : `No configured fetchers can return ${format}.`,
      };
    }

    return router.route(ready, {
      call: async (id, key, signal): Promise<Page> => {
        const proxy = usesProxy(router.get(id).kind) ? options.proxy : undefined;
        const page = await router.get(id).fetch(url, {
          format,
          maxCharacters,
          signal,
          key,
          proxy,
          allowPrivateNetworks: options.allowPrivateNetworks,
          resolve: options.resolve,
        });
        const content = page.content.trim();
        return { ...page, format, content: content.slice(0, maxCharacters), truncated: content.length > maxCharacters };
      },
      accept: (page) => page.content.length > 0,
      empty: "empty page",
    });
  }

  return { fetch: fetchPage, status: router.status };
}
