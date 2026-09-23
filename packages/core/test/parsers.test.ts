import { expect, test } from "bun:test";
import { assertRelevant, SoftBlockError, unwrapRedirect } from "../src/html";
import { parseBrave, parseBraveWeb } from "../src/search/providers/brave";
import { parseDuckduckgoHtml, parseDuckduckgoLite } from "../src/search/providers/duckduckgo";
import { parseExa, parseExaMcp } from "../src/search/providers/exa";
import { parseFirecrawl } from "../src/search/providers/firecrawl";
import { parseHnAlgolia } from "../src/search/providers/hnAlgolia";
import { parseKeenable } from "../src/search/providers/keenable";
import { parseMarginalia } from "../src/search/providers/marginalia";
import { parseMwmbl } from "../src/search/providers/mwmbl";
import { parseOpenalex } from "../src/search/providers/openalex";
import { parseParallel } from "../src/search/providers/parallel";
import { parseSearchX } from "../src/search/providers/searchx";
import { parseStackExchange } from "../src/search/providers/stackExchange";
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

test("parses a captured Tavily keyless response", async () => {
  const items = await parseTavily(QUERY, await Bun.file(`${import.meta.dir}/fixtures/tavily-keyless.json`).text());
  expect(items).toEqual([
    {
      title: "Understanding Ownership - The Rust Programming Language",
      url: "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html",
      description:
        "Ownership is Rust’s most unique feature and has deep implications for the rest of the language. It enables Rust to make memory safety guarantees without needing a garbage collector, so it’s important to understand how ownership works. In this chapter, we’ll talk about ownership as well as several related features: borrowing, slices, and how Rust lays data out in memory.",
      publishedAt: undefined,
    },
    {
      title: "What is Ownership? - The Rust Programming Language",
      url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
      description:
        "Ownership is a set of rules that govern how a Rust program manages memory. All programs have to manage the way they use a computer’s memory while running. Some languages have garbage collection that regularly looks for no-longer-used memory as the program runs; in other languages, the programmer must explicitly allocate and free the memory. Rust uses a third approach: Memory is managed through a system of ownership with a set of rules that the compiler checks. If any of the rules are violated, [...] Because ownership is a new concept for many programmers, it does take some time to get used to. The good news is that the more experienced you become with Rust and the rules of the ownership system, the easier you’ll find it to naturally develop code that is safe and efficient. Keep at it! [...] First, let’s take a look at the ownership rules. Keep these rules in mind as we work through the examples that illustrate them:\n\n Each value in Rust has an owner.\n There can only be one owner at a time.\n When the owner goes out of scope, the value will be dropped.\n\n### Variable Scope",
      publishedAt: undefined,
    },
  ]);
});

test("parses a captured SearchX response", async () => {
  const items = await parseSearchX(QUERY, await Bun.file(`${import.meta.dir}/fixtures/searchx.json`).text());
  expect(items).toEqual([
    {
      title: "Rust Ownership Explained: The One Concept Every...",
      url: "https://medium.com/@johirbuet/rust-ownership-explained-the-one-concept-every-beginner-struggles-with-eb16641f3944",
      description:
        "Ownership is the most important and most confusing concept in Rust, but also the one that makes Rust so powerful. In this post, we'll break it down using simple examples and real-life...",
      publishedAt: undefined,
    },
    {
      title: "cordx56/rustowl",
      url: "https://github.com/cordx56/rustowl",
      description: "Visualize Ownership and Lifetimes in Rust [Rust] 5210",
      publishedAt: undefined,
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

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

test("parses a captured HN Algolia response", async () => {
  const items = await parseHnAlgolia(QUERY, await fixture("hn-algolia.json"));
  expect(items).toEqual([
    {
      title: "Rust Ownership Rules",
      url: "https://www.geekabyte.io/2020/02/rust-ownership-rules.html",
      description: "317 points · 170 comments · by dade",
      publishedAt: "2020-03-02",
    },
    {
      title: "Short intro to C++ for Rust developers: Ownership and Borrowing",
      url: "http://nercury.github.io/c++/intro/2017/01/22/cpp-for-rust-devs.html",
      description: "195 points · 97 comments · by ingve",
      publishedAt: "2017-01-22",
    },
  ]);
});

// Ask HN stories are submitted without a url, so they have to link back to the thread.
test("links an Ask HN story that carries no url to its thread", async () => {
  const items = await parseHnAlgolia(QUERY, await fixture("hn-algolia-ask.json"));
  expect(items).toEqual([
    {
      title: "Ask HN: Will Rust ever become a mainstream systems programming language?",
      url: "https://news.ycombinator.com/item?id=14081178",
      description: "82 points · 279 comments · by justinucd",
      publishedAt: "2017-04-10",
    },
  ]);
});

test("parses a captured Stack Exchange response with body snippets", async () => {
  const items = await parseStackExchange(QUERY, await fixture("stackexchange.json"));
  expect(items.map((item) => ({ ...item, description: undefined }))).toEqual([
    {
      title: "Rust Ownership Smart Pointers",
      url: "https://stackoverflow.com/questions/63764669/rust-ownership-smart-pointers",
      description: undefined,
      publishedAt: "2020-09-06",
    },
    {
      title: "How to enable Rust Ownership paradigm in C++",
      url: "https://stackoverflow.com/questions/30011603/how-to-enable-rust-ownership-paradigm-in-c",
      description: undefined,
      publishedAt: "2015-05-03",
    },
  ]);
  expect(items[0]?.description).toBe(
    'answered · 5 votes · 1 answer · rust — I\'ve recently started learning Rust and just learned about the Smart Pointers (Box, Rc and RefCell). In the guide they talked about Rc implementing "shared ownership". But if I understood it correctly, the whole point of the ownership system is that there can only be one owner. And to me (still a Rust newbie) it seems as if Rc and RefCell take ownership of they value they contain and just "expose"',
  );
  expect(items[1]?.description).toContain("answered · 44 votes · 4 answers · c++, rust, smart-pointers — ");
});

// The docs require a client that reads backoff to wait, so the parser fails and the router benches it.
test("refuses a Stack Exchange response that asks for backoff", async () => {
  const body = JSON.stringify({ items: [], backoff: 10 });
  expect(() => parseStackExchange(QUERY, body)).toThrow("Stack Exchange asked for a 10s backoff");
});

test("parses a captured OpenAlex response and rebuilds the abstract", async () => {
  const items = await parseOpenalex(QUERY, await fixture("openalex.json"));
  expect(items.map((item) => ({ ...item, description: undefined }))).toEqual([
    {
      title: "Ownership Guided C to Rust Translation",
      url: "https://doi.org/10.1007/978-3-031-37709-9_22",
      description: undefined,
      publishedAt: "2023-01-01",
    },
    {
      title: "RustBelt: securing the foundations of the Rust programming language",
      url: "https://doi.org/10.1145/3158154",
      description: undefined,
      publishedAt: "2017-12-27",
    },
  ]);
  expect(items[0]?.description).toStartWith("Abstract Dubbed a safer C, Rust is a modern programming language");
  expect(items[0]?.description).toContain("scales to real-world codebases");
  expect(items[1]?.description).toStartWith("Rust is a new systems programming language");
});

// A work with no abstract still has to describe itself, so fall back to its citation count and venue.
test("falls back to citations and venue when a work has no abstract", async () => {
  const body = JSON.stringify({
    results: [
      {
        id: "https://openalex.org/W1",
        title: "A work without an abstract",
        cited_by_count: 12,
        primary_location: { source: { display_name: "Journal of Testing" } },
      },
    ],
  });
  const items = await parseOpenalex(QUERY, body);
  expect(items).toEqual([
    {
      title: "A work without an abstract",
      url: "https://openalex.org/W1",
      description: "12 citations · Journal of Testing",
      publishedAt: undefined,
    },
  ]);
});
