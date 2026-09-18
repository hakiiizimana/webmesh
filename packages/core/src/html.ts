import type { SearchItem } from "./types";

export type ResultSelectors = {
  start: string;
  link: string;
  title: string;
  description: string;
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as const;
const isEntity = (name: string): name is keyof typeof ENTITIES => Object.hasOwn(ENTITIES, name);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    const name = code.toLowerCase();
    return isEntity(name) ? ENTITIES[name] : match;
  });
}

export const clean = (text: string) =>
  decodeEntities(text.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

export function unwrapRedirect(href: string): string {
  const url = URL.parse(href.startsWith("//") ? `https:${href}` : href);
  if (!url) return href;
  const target = url.searchParams.get("uddg");
  if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/" && target) return target;
  return href.startsWith("//") ? url.href : href;
}

export class SoftBlockError extends Error {}

export function assertRelevant(query: string, items: SearchItem[]): void {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (items.length === 0 || words.length === 0) return;
  const relevant = items.some((item) => {
    const text = `${item.title} ${item.description} ${item.url}`.toLowerCase();
    return words.some((w) => text.includes(w));
  });
  if (!relevant) throw new SoftBlockError(`soft-blocked: ${items.length} results, none about the query`);
}

export async function scrapeResults(query: string, html: string, sel: ResultSelectors): Promise<SearchItem[]> {
  const items: SearchItem[] = [];
  const current = () => items.at(-1);

  const rewriter = new HTMLRewriter()
    .on(sel.start, {
      element() {
        items.push({ title: "", url: "", description: "" });
      },
    })
    .on(sel.link, {
      element(el) {
        const item = current();
        const href = el.getAttribute("href");
        if (!item || item.url || !href) return;
        const url = unwrapRedirect(decodeEntities(href));
        if (url.startsWith("http")) item.url = url;
      },
    })
    .on(sel.title, {
      text(chunk) {
        const item = current();
        if (item) item.title += chunk.text;
      },
    })
    .on(sel.description, {
      text(chunk) {
        const item = current();
        if (item) item.description += chunk.text;
      },
    });

  await rewriter.transform(new Response(html)).text();

  const cleaned = items
    .map((item) => ({ ...item, title: clean(item.title), description: clean(item.description) }))
    .filter((item) => item.url && item.title);
  assertRelevant(query, cleaned);
  return cleaned;
}
