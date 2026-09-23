import { extractText } from "unpdf";
import { request, ResponseTooLargeError } from "../../http";
import { blockedUrl } from "../../network";
import { TargetError } from "../../router";
import type { FetchedPage, FetchContext } from "../types";
import { linksFromHtml } from "./links";
import { MIN_WORDS, assertReadable, normalizePage, pageFromHtml } from "./page";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT =
  "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, text/plain;q=0.7, application/pdf;q=0.6, */*;q=0.5";

function markdownTitle(content: string): string | undefined {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim();
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

export async function fetchDirect(
  url: string,
  { format, formats, signal, proxy, allowPrivateNetworks, allowPrivateHosts, resolve }: FetchContext,
): Promise<FetchedPage> {
  let target = url;
  let res;
  for (let redirects = 0; ; redirects += 1) {
    if (!allowPrivateNetworks) {
      const error = await blockedUrl(target, resolve, allowPrivateHosts);
      if (error) throw new TargetError(error);
    }
    try {
      res = await request(target, { signal, browser: true, proxy, redirect: "manual", headers: { accept: ACCEPT } });
    } catch (err) {
      // The page is too big to read locally; the fetcher itself is fine.
      throw err instanceof ResponseTooLargeError ? new TargetError(err.message) : err;
    }
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location) break;
    if (redirects >= 9) throw new TargetError("too many redirects");
    target = new URL(location, target).href;
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const metadata = {
    statusCode: res.status,
    contentType: type || undefined,
    language: res.headers.get("content-language") ?? undefined,
  };
  if (isPdf(type, target)) return { ...(await pageFromPdf(await res.bytes(), target)), metadata };
  const body = await res.text();
  if (type.includes("markdown")) {
    return normalizePage({ url: target, title: markdownTitle(body) || target, content: body, metadata }, format);
  }
  assertReadable(body);
  if (type.includes("html")) {
    return {
      ...(await pageFromHtml(body, target, format)),
      metadata,
      rawHtml: formats.includes("rawHtml") ? body : undefined,
      links: formats.includes("links") ? linksFromHtml(body, target) : undefined,
    };
  }
  if (type.startsWith("text/") || type.includes("json")) return { url: target, title: target, content: body, metadata };
  throw new Error(`can't read ${type || "this content type"} locally`);
}
