import { Defuddle } from "defuddle/node";
import { z } from "zod";
import { agentBrowserPath, createBrowser } from "./browser";
import { clean } from "./html";
import { request } from "./http";
import { callMcp } from "./mcp";
import { publishedDate } from "./parser";
import { createRouter, type Routed, type RouterOptions, TargetError } from "./router";
import type { ProviderKind } from "./types";

const BUDGET_MS = 30_000;
const HEDGE_MS = 3_000;
const MAX_CHARACTERS = 50_000;
const MIN_WORDS = 25;

export type PageFormat = "markdown" | "html";

export type FetchedPage = { url: string; title: string; content: string; publishedAt?: string };

export type FetchContext = { format: PageFormat; maxCharacters: number; signal: AbortSignal; key: string };

export type Fetcher = {
  kind: ProviderKind;
  env?: string;
  available?: () => boolean;
  formats: readonly PageFormat[];
  fetch: (url: string, context: FetchContext) => Promise<FetchedPage>;
};

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

async function fetchDirect(url: string, { format, signal }: FetchContext): Promise<FetchedPage> {
  const res = await request(url, {
    signal,
    browser: true,
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5" },
  });
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (type.includes("html")) return pageFromHtml(body, url, format);
  if (type.startsWith("text/") || type.includes("json")) return { url, title: url, content: body };
  throw new Error(`can't read ${type || "this content type"} locally`);
}

const openedPage = z.object({ title: z.string().optional(), url: z.string().optional() });
const readPage = z.object({ content: z.string(), status: z.number().nullish() });

async function fetchInBrowser(url: string, { signal }: FetchContext): Promise<FetchedPage> {
  const browser = createBrowser(`webmesh-fetch-${crypto.randomUUID().slice(0, 8)}`);
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
  return pageFromJina(await res.text());
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
  return pageFromFirecrawl(await res.text(), url, format);
}

export function pageFromExa(text: string, url: string): FetchedPage {
  const title = text.match(/^# (.*)$/m)?.[1]?.trim();
  const content = text.replace(/^# .*\n(?:URL: .*\n)?/, "").trim();
  return { url, title: title || url, content };
}

async function fetchExaMcp(url: string, { maxCharacters, signal }: FetchContext): Promise<FetchedPage> {
  // One extra character tells a cut page apart from one that fit.
  const args = { urls: [url], maxCharacters: maxCharacters + 1 };
  return pageFromExa(await callMcp("https://mcp.exa.ai/mcp", "web_fetch_exa", args, signal, false), url);
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

async function fetchParallelMcp(url: string, { signal }: FetchContext): Promise<FetchedPage> {
  const args = { urls: [url], full_content: true };
  return pageFromParallel(await callMcp("https://search.parallel.ai/mcp", "web_fetch", args, signal, true), url);
}

export const fetchers = {
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

export function createFetch<R extends Record<string, Fetcher>>(registry: R, options: RouterOptions) {
  type Id = keyof R & string;
  const router = createRouter("fetch", registry, options, { budgetMs: BUDGET_MS, hedgeMs: HEDGE_MS });

  async function fetchPage(
    url: string,
    { format = "markdown", maxCharacters = MAX_CHARACTERS, only }: FetchOptions<Id> = {},
  ): Promise<FetchResult> {
    const protocol = URL.parse(url)?.protocol;
    if (protocol !== "https:" && protocol !== "http:") return { success: false, error: "Only http and https URLs can be fetched." };
    const configured = (only ?? router.ids).filter(router.isReady);
    const ready = configured.filter((id) => router.get(id).formats.includes(format));
    if (ready.length === 0) {
      return {
        success: false,
        error: configured.length === 0 ? "No fetchers configured." : `No configured fetchers can return ${format}.`,
      };
    }

    return router.route(ready, {
      call: async (id, key, signal): Promise<Page> => {
        const page = await router.get(id).fetch(url, { format, maxCharacters, signal, key });
        const content = page.content.trim();
        return { ...page, format, content: content.slice(0, maxCharacters), truncated: content.length > maxCharacters };
      },
      accept: (page) => page.content.length > 0,
      empty: "empty page",
    });
  }

  return { fetch: fetchPage, status: router.status };
}
