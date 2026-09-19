import { expect, test } from "bun:test";
import { assertRelevant, SoftBlockError, unwrapRedirect } from "../src/html";
import { parse } from "../src/parser";

const QUERY = "rust ownership";

test("duckduckgo html unwraps redirect links and reads snippets", async () => {
  const html = `
    <div class="web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html")}&rut=abc">Understanding Ownership</a>
      <div class="result__snippet">Ownership is Rust's most unique feature</div>
    </div>`;
  const items = await parse("duckduckgo-html", QUERY, html);
  expect(items[0]).toEqual({
    title: "Understanding Ownership",
    url: "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html",
    description: "Ownership is Rust's most unique feature",
  });
});

test("duckduckgo lite reads the snippet from the following row", async () => {
  const html = `
    <table>
      <tr><td><a class="result-link" href="https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html">Understanding Ownership</a></td></tr>
      <tr><td class="result-snippet">Ownership is Rust's most unique feature</td></tr>
    </table>`;
  const items = await parse("duckduckgo-lite", QUERY, html);
  expect(items[0]?.url).toBe("https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html");
  expect(items[0]?.description).toContain("Ownership");
});

test("brave web reads title, url, and snippet", async () => {
  const html = `
    <div class="snippet" data-type="web">
      <a href="https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html"><div class="title">Understanding Ownership</div></a>
      <div class="generic-snippet"><div class="content">Ownership is Rust's most unique feature</div></div>
    </div>`;
  const items = await parse("brave-web", QUERY, html);
  expect(items[0]).toEqual({
    title: "Understanding Ownership",
    url: "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html",
    description: "Ownership is Rust's most unique feature",
  });
});

test("parses Firecrawl news results", async () => {
  const items = await parse(
    "firecrawl",
    QUERY,
    JSON.stringify({
      data: {
        news: [{ title: "Rust news", url: "https://news.example.com/rust", snippet: "A Rust update" }],
      },
    }),
  );
  expect(items).toEqual([{ title: "Rust news", url: "https://news.example.com/rust", description: "A Rust update" }]);
});

test("parses Brave news results", async () => {
  const items = await parse(
    "brave",
    QUERY,
    JSON.stringify({
      news: { results: [{ title: "Rust news", url: "https://news.example.com/rust", description: "A Rust update" }] },
    }),
  );
  expect(items).toEqual([{ title: "Rust news", url: "https://news.example.com/rust", description: "A Rust update" }]);
});

test("parses Parallel structured results without truncating excerpts", async () => {
  const description = "A complete excerpt. ".repeat(20).trim();
  const items = await parse(
    "parallel",
    QUERY,
    JSON.stringify({
      search_id: "search-123",
      results: [{ title: "Rust book", url: "https://doc.rust-lang.org/book/", publish_date: null, excerpts: [description] }],
      warnings: null,
      metadata: null,
      session_id: "session-123",
    }),
  );
  expect(items).toEqual([{ title: "Rust book", url: "https://doc.rust-lang.org/book/", description }]);
});

test("exa mcp parses --- blocks and treats Title N/A as the url", async () => {
  const items = await parse(
    "exa-mcp",
    QUERY,
    `Title: N/A
URL: https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html
Highlights:
Ownership is Rust's most unique feature
---
Title: References and Borrowing
URL: https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html
Highlights:
borrowing without taking ownership`,
  );
  expect(items).toHaveLength(2);
  expect(items[0]?.title).toBe("https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html");
  expect(items[1]?.title).toBe("References and Borrowing");
});

test("unwrapRedirect resolves DuckDuckGo links and leaves others alone", () => {
  const target = "https://bun.com/docs/runtime?x=1";
  expect(unwrapRedirect(`//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`)).toBe(target);
  expect(unwrapRedirect("https://example.com/?uddg=x")).toBe("https://example.com/?uddg=x");
});

test("assertRelevant flags off-topic pages as a soft block", () => {
  const junk = [{ title: "YouTube", url: "https://youtube.com", description: "Enjoy videos" }];
  expect(() => assertRelevant(QUERY, junk)).toThrow(SoftBlockError);
  expect(() => assertRelevant(QUERY, [...junk, { title: "Rust book", url: "https://x.dev", description: "" }])).not.toThrow();
});

test("reads publish dates as YYYY-MM-DD and drops relative ones", async () => {
  const parallel = await parse(
    "parallel",
    QUERY,
    JSON.stringify({ results: [{ url: "https://bun.sh/blog/bun-v1.3", title: "Bun 1.3", publish_date: "2025-10-10" }] }),
  );
  const exaMcp = await parse("exa-mcp", QUERY, "Title: Bun 1.3\nURL: https://bun.sh/blog/bun-v1.3\nPublished: 2025-10-10T00:00:00.000Z\nHighlights:\nBun 1.3");
  const firecrawl = await parse(
    "firecrawl",
    QUERY,
    JSON.stringify({
      data: {
        news: [
          { url: "https://a.example.com", title: "Absolute", date: "May 6, 2026" },
          { url: "https://b.example.com", title: "Relative", date: "1 week ago" },
        ],
      },
    }),
  );

  expect(parallel[0]?.publishedAt).toBe("2025-10-10");
  expect(exaMcp[0]?.publishedAt).toBe("2025-10-10");
  expect(firecrawl.map((item) => item.publishedAt)).toEqual(["2026-05-06", undefined]);
});
