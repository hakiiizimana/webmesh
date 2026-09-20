import { parseHTML } from "linkedom";

// Return absolute navigable links in document order, keeping the first occurrence.
export function linksFromHtml(html: string, url: string): string[] {
  const { document } = parseHTML(html);
  const links = new Set<string>();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const target = URL.parse(href, url);
    if (target?.protocol === "http:" || target?.protocol === "https:") links.add(target.href);
  }
  return [...links];
}
