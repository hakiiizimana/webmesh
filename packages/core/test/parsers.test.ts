import { expect, test } from "bun:test";
import { assertRelevant, SoftBlockError, unwrapRedirect } from "../src/html";
import { parseBrave, parseBraveWeb } from "../src/search/providers/brave";
import { parseDuckduckgoHtml, parseDuckduckgoLite } from "../src/search/providers/duckduckgo";
import { parseExa, parseExaMcp } from "../src/search/providers/exa";
import { parseFirecrawl } from "../src/search/providers/firecrawl";
import { parseKeenable } from "../src/search/providers/keenable";
import { parseMarginalia } from "../src/search/providers/marginalia";
import { parseMwmbl } from "../src/search/providers/mwmbl";
import { parseParallel } from "../src/search/providers/parallel";
import { parseTavily } from "../src/search/providers/tavily";
import { parseTinyfish } from "../src/search/providers/tinyfish";

const QUERY = "rust ownership";

test("duckduckgo html unwraps redirect links and reads snippets", async () => {
  const html = `
    <div class="web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html")}&rut=abc">Understanding Ownership</a>
      <div class="result__snippet">Ownership is Rust's most unique feature</div>
    </div>`;
  const items = await parseDuckduckgoHtml(QUERY, html);
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
  const items = await parseDuckduckgoLite(QUERY, html);
  expect(items[0]?.url).toBe("https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html");
  expect(items[0]?.description).toContain("Ownership");
});

test("brave web reads title, url, and snippet", async () => {
  const html = `
    <div class="snippet" data-type="web">
      <a href="https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html"><div class="title">Understanding Ownership</div></a>
      <div class="generic-snippet"><div class="content">Ownership is Rust's most unique feature</div></div>
    </div>`;
  const items = await parseBraveWeb(QUERY, html);
  expect(items[0]).toEqual({
    title: "Understanding Ownership",
    url: "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html",
    description: "Ownership is Rust's most unique feature",
  });
});

test("parses Firecrawl news results", async () => {
  const items = await parseFirecrawl(QUERY,
    JSON.stringify({
      data: {
        news: [{ title: "Rust news", url: "https://news.example.com/rust", snippet: "A Rust update" }],
      },
    }),
  );
  expect(items).toEqual([{ title: "Rust news", url: "https://news.example.com/rust", description: "A Rust update" }]);
});

test("parses Brave news results", async () => {
  const items = await parseBrave(QUERY,
    JSON.stringify({
      news: { results: [{ title: "Rust news", url: "https://news.example.com/rust", description: "A Rust update" }] },
    }),
  );
  expect(items).toEqual([{ title: "Rust news", url: "https://news.example.com/rust", description: "A Rust update" }]);
});

test("parses Parallel structured results without truncating excerpts", async () => {
  const description = "A complete excerpt. ".repeat(20).trim();
  const items = await parseParallel(QUERY,
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
  const items = await parseExaMcp(QUERY,
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
  const parallel = await parseParallel(QUERY,
    JSON.stringify({ results: [{ url: "https://bun.sh/blog/bun-v1.3", title: "Bun 1.3", publish_date: "2025-10-10" }] }),
  );
  const exaMcp = await parseExaMcp(QUERY, "Title: Bun 1.3\nURL: https://bun.sh/blog/bun-v1.3\nPublished: 2025-10-10T00:00:00.000Z\nHighlights:\nBun 1.3");
  const firecrawl = await parseFirecrawl(QUERY,
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

test("exa mcp preserves markdown formatting in highlights while stripping leading hashes", async () => {
  const body = `Title: Markdown Spec
URL: https://spec.commonmark.org
Highlights:
### CommonMark
- Item one
- Item two
\`\`\`js
console.log("code block");
\`\`\`
---
Title: Other
URL: https://other.org
Highlights:
plain text`;
  const items = await parseExaMcp(QUERY, body);
  expect(items[0]?.description).toContain("CommonMark\n- Item one\n- Item two\n```js\nconsole.log(\"code block\");\n```");
});

test("brave normalizes HTML entities and strips tags from titles and descriptions", async () => {
  const body = JSON.stringify({
    web: {
      results: [
        {
          title: "Rust &amp; <b>Memory</b> &quot;Safety&quot;",
          url: "https://doc.rust-lang.org/safety",
          description: "Learn about <i>ownership</i> &amp; &apos;lifetimes&apos;",
        },
      ],
    },
  });
  const items = await parseBrave(QUERY, body);
  expect(items[0]).toEqual({
    title: 'Rust & Memory "Safety"',
    url: "https://doc.rust-lang.org/safety",
    description: "Learn about ownership & 'lifetimes'",
    publishedAt: undefined,
  });
});

test("duckduckgo html normalizes HTML tags and entities in titles and snippets", async () => {
  const html = `
    <div class="web-result">
      <a class="result__a" href="https://doc.rust-lang.org/book">Rust &amp; <b>Ownership</b> &lt;Book&gt;</a>
      <div class="result__snippet">Understanding Rust&#39;s &quot;borrow checker&quot; &amp; safety</div>
    </div>`;
  const items = await parseDuckduckgoHtml(QUERY, html);
  expect(items[0]?.title).toBe("Rust & Ownership <Book>");
  expect(items[0]?.description).toBe('Understanding Rust\'s "borrow checker" & safety');
});

test("assertRelevant flags bot check and CAPTCHA results as a soft block", () => {
  const blockItems = [
    {
      title: "Attention Required! | Cloudflare",
      url: "https://example.com/challenge",
      description: "Please complete the security check to proceed.",
    },
    {
      title: "Verify you are human",
      url: "https://example.com/captcha",
      description: "Cloudflare ray ID verification",
    },
  ];
  expect(() => assertRelevant(QUERY, blockItems)).toThrow(SoftBlockError);
});

test("tavily parses clean public items with published date", async () => {
  const body = JSON.stringify({
    results: [
      {
        title: "Tavily Rust Ownership",
        url: "https://tavily.example/rust",
        content: "Rust ownership guide content",
        published_date: "2026-03-01T12:00:00Z",
      },
    ],
  });
  const items = await parseTavily(QUERY, body);
  expect(items).toEqual([
    {
      title: "Tavily Rust Ownership",
      url: "https://tavily.example/rust",
      description: "Rust ownership guide content",
      publishedAt: "2026-03-01",
    },
  ]);
});

test("exa parses clean public items with highlights joined", async () => {
  const body = JSON.stringify({
    results: [
      {
        title: "Exa Rust Ownership",
        url: "https://exa.example/rust",
        publishedDate: "2026-02-14",
        highlights: ["First excerpt", "Second excerpt"],
      },
    ],
  });
  const items = await parseExa(QUERY, body);
  expect(items).toEqual([
    {
      title: "Exa Rust Ownership",
      url: "https://exa.example/rust",
      description: "First excerpt … Second excerpt",
      publishedAt: "2026-02-14",
    },
  ]);
});

test("keenable parses clean public items using snippet or description", async () => {
  const body = JSON.stringify({
    results: [
      { title: "Keenable Snippet", url: "https://k.example/1", snippet: "Snippet text" },
      { title: "Keenable Desc", url: "https://k.example/2", description: "Description text" },
    ],
  });
  const items = await parseKeenable(QUERY, body);
  expect(items).toEqual([
    { title: "Keenable Snippet", url: "https://k.example/1", description: "Snippet text", publishedAt: undefined },
    { title: "Keenable Desc", url: "https://k.example/2", description: "Description text", publishedAt: undefined },
  ]);
});

test("marginalia parses results and tolerates a missing description", async () => {
  const body = JSON.stringify({
    query: QUERY,
    license: "CC-BY-NC-SA",
    results: [
      { title: "Ownership - The Rust Book", url: "https://doc.rust-lang.org/book/ch04-00.html", description: "Ownership explained" },
      { title: "Rust ownership notes", url: "https://notes.example/rust" },
    ],
  });
  const items = await parseMarginalia(QUERY, body);
  expect(items).toEqual([
    {
      title: "Ownership - The Rust Book",
      url: "https://doc.rust-lang.org/book/ch04-00.html",
      description: "Ownership explained",
      publishedAt: undefined,
    },
    { title: "Rust ownership notes", url: "https://notes.example/rust", description: "", publishedAt: undefined },
  ]);
});

test("tinyfish parses snippets, dates, and missing snippets", async () => {
  const body = JSON.stringify({
    query: QUERY,
    total_results: 2,
    page: 0,
    results: [
      {
        position: 1,
        site_name: "doc.rust-lang.org",
        title: "Understanding Ownership",
        snippet: "Ownership is Rust's most unique feature",
        url: "https://doc.rust-lang.org/book/ch04-00.html",
        date: "2026-03-04T00:00:00Z",
      },
      { position: 2, site_name: "notes.example", title: "No snippet", url: "https://notes.example/rust" },
    ],
  });
  const items = await parseTinyfish(QUERY, body);
  expect(items).toEqual([
    {
      title: "Understanding Ownership",
      url: "https://doc.rust-lang.org/book/ch04-00.html",
      description: "Ownership is Rust's most unique feature",
      publishedAt: "2026-03-04",
    },
    { title: "No snippet", url: "https://notes.example/rust", description: "", publishedAt: undefined },
  ]);
});

test("mwmbl parses clean public items by combining fragment values", async () => {
  const body = JSON.stringify([
    {
      url: "https://mwmbl.example/rust",
      title: [{ value: "Mwmbl " }, { value: "Rust Ownership" }],
      extract: [{ value: "Fragment one " }, { value: "fragment two" }],
    },
  ]);
  const items = await parseMwmbl(QUERY, body);
  expect(items).toEqual([
    {
      title: "Mwmbl Rust Ownership",
      url: "https://mwmbl.example/rust",
      description: "Fragment one fragment two",
      publishedAt: undefined,
    },
  ]);
});
