import { expect, test } from "bun:test";
import { createFetch, type FetchedPage, type Fetcher, pageFromExa, pageFromHtml, pageFromJina } from "../src/fetch";
import { HttpError } from "../src/http";
import { TargetError } from "../src/router";
import { memoryStore } from "../src/state";

const ARTICLE = `<html><head><title>WAL mode | SQLite Notes</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About us and our sponsors</a></nav>
<article><h1>WAL mode</h1>
<p>Write-ahead logging lets readers keep reading while a single writer appends changes to a separate log file,
and a checkpoint later folds those changes back into the main database file without blocking readers.</p>
<pre><code class="language-sql">PRAGMA journal_mode = WAL;</code></pre>
</article></body></html>`;

function fetcher(result: FetchedPage | Error, kind: Fetcher["kind"] = "public", formats: Fetcher["formats"] = ["markdown", "html"]) {
  const calls: string[] = [];
  const provider: Fetcher = {
    kind,
    formats,
    async fetch(url) {
      calls.push(url);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return Object.assign(provider, { calls });
}

const page = (content: string): FetchedPage => ({ url: "https://a.com", title: "A", content });

const setup = <R extends Record<string, Fetcher>>(registry: R) =>
  createFetch(registry, { store: memoryStore(), env: {}, random: () => 0, retryDelayMs: 0 });

test("turns a page into its main content, keeping code blocks", async () => {
  const markdown = await pageFromHtml(ARTICLE, "https://notes.example/wal", "markdown");
  const html = await pageFromHtml(ARTICLE, "https://notes.example/wal", "html");

  expect(markdown.title).toBe("WAL mode | SQLite Notes");
  expect(markdown.content).toContain("PRAGMA journal_mode = WAL;");
  expect(markdown.content).toContain("```");
  expect(markdown.content).not.toContain("sponsors");
  expect(html.content).toContain("<pre>");
});

test("rejects a page that is only a JavaScript shell", async () => {
  const shell = `<html><head><title>App</title></head><body><div id="root"></div><noscript>Enable JavaScript</noscript></body></html>`;
  await expect(pageFromHtml(shell, "https://app.example", "markdown")).rejects.toThrow("too little content");
});

test("reads reader responses and reports failed pages as the page's fault", () => {
  expect(pageFromExa("# WAL mode\nURL: https://a.com\n\nBody text", "https://a.com")).toEqual({
    url: "https://a.com",
    title: "WAL mode",
    content: "Body text",
  });
  expect(pageFromJina(JSON.stringify({ data: { url: "https://a.com", title: "A", html: "<p>x</p>" } })).content).toBe("<p>x</p>");
  expect(() => pageFromJina(JSON.stringify({ data: { url: "https://a.com", content: "", httpStatus: 404 } }))).toThrow(TargetError);
});

test("falls back to a reader when the local fetch fails, and never cools the local fetcher down", async () => {
  const registry = { reader: fetcher(page("from reader")), direct: fetcher(new HttpError(403, undefined, "HTTP 403"), "local") };
  const { fetch } = setup(registry);

  const first = await fetch("https://a.com");
  await fetch("https://a.com");

  expect(first).toMatchObject({ success: true, provider: "reader", attempts: ["direct: HTTP 403"] });
  expect(registry.direct.calls).toHaveLength(2);
});

test("tries the local fetch, then the browser, then remote readers, and skips a browser that isn't installed", async () => {
  const registry = {
    reader: fetcher(page("from reader")),
    browser: fetcher(page("rendered"), "browser"),
    direct: fetcher(new Error("too little content"), "local"),
  };
  const missing = { ...fetcher(page("rendered"), "browser"), available: () => false };

  const rendered = await setup(registry).fetch("https://app.example");
  const skipped = await setup({ reader: registry.reader, missing }).fetch("https://app.example");

  expect(rendered).toMatchObject({ success: true, provider: "browser", attempts: ["direct: too little content"] });
  expect(skipped).toMatchObject({ success: true, provider: "reader" });
  expect(missing.calls).toHaveLength(0);
});

test("a failed page does not cool the reader down", async () => {
  const reader = fetcher(new TargetError("page returned HTTP 404"));
  const { fetch } = setup({ reader });

  await fetch("https://a.com/missing");
  await fetch("https://a.com/other");

  expect(reader.calls).toHaveLength(2);
});

test("only asks fetchers that can return the requested format", async () => {
  const registry = { markdownOnly: fetcher(page("md"), "mcp", ["markdown"]), both: fetcher(page("<p>html</p>")) };
  const result = await setup(registry).fetch("https://a.com", { format: "html" });

  expect(result).toMatchObject({ success: true, provider: "both" });
  expect(registry.markdownOnly.calls).toHaveLength(0);
});

test("cuts content at maxCharacters and says so", async () => {
  const result = await setup({ reader: fetcher(page("x".repeat(1_500))) }).fetch("https://a.com", { maxCharacters: 1_000 });
  expect(result.success && [result.data.content.length, result.data.truncated]).toEqual([1_000, true]);
});

test("refuses anything but http and https", async () => {
  const reader = fetcher(page("secret"));
  const result = await setup({ reader }).fetch("file:///etc/passwd");

  expect(result).toEqual({ success: false, error: "Only http and https URLs can be fetched." });
  expect(reader.calls).toHaveLength(0);
});
