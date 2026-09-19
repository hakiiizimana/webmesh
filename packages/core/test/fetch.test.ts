import { expect, test } from "bun:test";
import {
  createFetch,
  fetchers,
  type FetchedPage,
  type Fetcher,
  pageFromExa,
  pageFromFirecrawl,
  pageFromHtml,
  pageFromJina,
  pageFromParallel,
} from "../src/fetch";
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
  createFetch(registry, {
    store: memoryStore(),
    env: {},
    random: () => 0,
    retryDelayMs: 0,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });

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

  expect(first).toMatchObject({ success: true, data: { content: "from reader" } });
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

  expect(rendered).toMatchObject({ success: true, data: { content: "rendered" } });
  expect(skipped).toMatchObject({ success: true, data: { content: "from reader" } });
  expect(missing.calls).toHaveLength(0);
});

test("only the local fetch and the browser use the proxy; readers go direct", async () => {
  const seen: Record<string, string | undefined> = {};
  const spy = (kind: Fetcher["kind"], result: FetchedPage | Error): Fetcher => ({
    kind,
    formats: ["markdown"],
    async fetch(_url, context) {
      seen[kind] = context.proxy;
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const registry = { reader: spy("public", page("ok")), direct: spy("local", new Error("too little content")) };
  await createFetch(registry, {
    store: memoryStore(),
    env: {},
    random: () => 0,
    proxy: "http://proxy:8000",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  }).fetch("https://a.com");

  expect(seen).toEqual({ local: "http://proxy:8000", public: undefined });
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

  expect(result).toMatchObject({ success: true, data: { content: "<p>html</p>" } });
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

test("blocks private DNS answers unless the setting allows them", async () => {
  const blocked = fetcher(page("secret"));
  const resolve = async () => [{ address: "10.1.2.3", family: 4 }];
  const options = { store: memoryStore(), env: {}, resolve };

  const denied = await createFetch({ blocked }, options).fetch("http://internal.example");
  const allowed = await createFetch({ blocked }, { ...options, allowPrivateNetworks: true }).fetch("http://internal.example");

  expect(denied).toMatchObject({ success: false, error: expect.stringContaining("private") });
  expect(allowed.success).toBe(true);
  expect(blocked.calls).toEqual(["http://internal.example"]);
});

test("passes the private-network setting to browser fetchers", async () => {
  let allowed: boolean | undefined;
  const browser: Fetcher = {
    kind: "browser",
    formats: ["markdown"],
    async fetch(_url, context) {
      allowed = context.allowPrivateNetworks;
      return page("rendered");
    },
  };

  await createFetch({ browser }, { store: memoryStore(), env: {}, allowPrivateNetworks: true }).fetch("http://127.0.0.1");

  expect(allowed).toBe(true);
});

test("blocks a redirect to a private address before following it", async () => {
  let privateRequests = 0;
  const destination = Bun.serve({ port: 0, fetch: () => new Response(String(++privateRequests)) });
  const source = Bun.serve({
    port: 0,
    fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}/secret`),
  });
  try {
    const resolve = async (hostname: string) => [
      { address: hostname === "127.0.0.1" ? "127.0.0.1" : "93.184.216.34", family: 4 },
    ];
    const result = await createFetch({ direct: fetchers.direct }, { store: memoryStore(), env: {}, resolve }).fetch(
      `http://localhost:${source.port}`,
    );

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("private") });
    expect(privateRequests).toBe(0);
  } finally {
    source.stop(true);
    destination.stop(true);
  }
});

test("preserves markdown responses from direct fetch without modifying markdown structure", async () => {
  const rawMarkdown = "# Heading\n\n- item 1\n- item 2\n\n```ts\nconst x = 1;\n```";
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(rawMarkdown, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
  });
  try {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    const result = await createFetch(
      { direct: fetchers.direct },
      { store: memoryStore(), env: {}, allowPrivateNetworks: true, resolve },
    ).fetch(`http://127.0.0.1:${server.port}/readme.md`, { format: "markdown" });

    expect(result).toMatchObject({
      success: true,
      data: {
        content: rawMarkdown,
        format: "markdown",
        truncated: false,
      },
    });
  } finally {
    server.stop(true);
  }
});

test("preserves markdown content from remote reader responses", () => {
  const markdown = "## Section\n\nText with [link](https://example.com) and `code`";
  const firecrawl = pageFromFirecrawl(
    JSON.stringify({ data: { markdown, metadata: { title: "Title" } } }),
    "https://example.com",
    "markdown",
  );
  expect(firecrawl.content).toBe(markdown);

  const parallel = pageFromParallel(
    JSON.stringify({ results: [{ url: "https://example.com", full_content: markdown }] }),
    "https://example.com",
  );
  expect(parallel.content).toBe(markdown);
});

test("normalizes HTML entity encoding in title and extracts clean markdown", async () => {
  const rawHtml = `<!DOCTYPE html><html><head><title>Architecture &amp; Design &lt;Guide&gt;</title></head><body>
  <article><h1>Architecture</h1><p>${"Real page content sentence. ".repeat(20)}</p></article></body></html>`;
  const parsed = await pageFromHtml(rawHtml, "https://example.com/arch", "markdown");
  expect(parsed.title).toBe("Architecture & Design <Guide>");
  expect(parsed.content).toContain("Real page content sentence.");
});

test("normalizes xhtml responses using html parser", async () => {
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
  <html xmlns="http://www.w3.org/1999/xhtml"><head><title>XHTML Spec</title></head><body>
  <article><h1>XHTML</h1><p>${"Valid xhtml content paragraph. ".repeat(25)}</p></article></body></html>`;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(xhtml, {
        headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
      }),
  });
  try {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    const result = await createFetch(
      { direct: fetchers.direct },
      { store: memoryStore(), env: {}, allowPrivateNetworks: true, resolve },
    ).fetch(`http://127.0.0.1:${server.port}/spec.xhtml`, { format: "markdown" });

    expect(result).toMatchObject({
      success: true,
      data: {
        title: "XHTML Spec",
        format: "markdown",
      },
    });
    if (result.success) {
      expect(result.data.content).toContain("Valid xhtml content paragraph.");
    }
  } finally {
    server.stop(true);
  }
});

test("local direct fetch rejects PDFs as unreadable locally and falls back to a reader", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("%PDF-1.5 fake binary pdf content", {
        headers: { "content-type": "application/pdf" },
      }),
  });
  try {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    const reader = fetcher(page("extracted pdf text content"));
    const client = createFetch(
      { direct: fetchers.direct, reader },
      { store: memoryStore(), env: {}, allowPrivateNetworks: true, resolve },
    );
    const result = await client.fetch(`http://127.0.0.1:${server.port}/paper.pdf`);

    expect(result).toMatchObject({
      success: true,
      data: { content: "extracted pdf text content" },
    });
    expect(reader.calls).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});

test("local direct fetch alone fails when encountering a PDF", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("%PDF-1.4 binary data", {
        headers: { "content-type": "application/pdf" },
      }),
  });
  try {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    const result = await createFetch(
      { direct: fetchers.direct },
      { store: memoryStore(), env: {}, allowPrivateNetworks: true, resolve },
    ).fetch(`http://127.0.0.1:${server.port}/file.pdf`);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("can't read application/pdf locally"),
    });
  } finally {
    server.stop(true);
  }
});

test("rejects reader responses that report HTTP 403 or 429 status codes", () => {
  expect(() =>
    pageFromJina(JSON.stringify({ data: { url: "https://a.com", content: "Access Denied", httpStatus: 403 } })),
  ).toThrow(TargetError);
  expect(() =>
    pageFromJina(JSON.stringify({ data: { url: "https://a.com", content: "Rate limited", httpStatus: 429 } })),
  ).toThrow(TargetError);
  expect(() =>
    pageFromFirecrawl(
      JSON.stringify({ data: { markdown: "Forbidden", metadata: { statusCode: 403 } } }),
      "https://a.com",
      "markdown",
    ),
  ).toThrow(TargetError);
});

test("rejects Cloudflare refusal and challenge pages due to insufficient content", async () => {
  const challenge = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
  <div class="main-wrapper"><span class="cf-error-title">Enable JavaScript and cookies to continue</span></div>
  </body></html>`;
  await expect(pageFromHtml(challenge, "https://cf.example", "markdown")).rejects.toThrow("too little content");
});

test("rejects empty page content returned by a fetcher", async () => {
  const emptyReader = fetcher(page(""));
  const result = await setup({ emptyReader }).fetch("https://a.com");
  expect(result).toMatchObject({
    success: false,
    error: expect.stringContaining("empty page"),
  });
});

test("blocks multi-hop manual redirect before following to a private address", async () => {
  let privateAccessed = 0;
  const privateTarget = Bun.serve({ port: 0, fetch: () => new Response(String(++privateAccessed)) });
  const hop2 = Bun.serve({
    port: 0,
    fetch: () => Response.redirect(`http://127.0.0.1:${privateTarget.port}/leak`),
  });
  const hop1 = Bun.serve({
    port: 0,
    fetch: () => Response.redirect(`http://localhost:${hop2.port}/step2`),
  });
  try {
    const resolve = async (hostname: string) => [
      { address: hostname === "127.0.0.1" ? "127.0.0.1" : "93.184.216.34", family: 4 },
    ];
    const result = await createFetch(
      { direct: fetchers.direct },
      { store: memoryStore(), env: {}, resolve },
    ).fetch(`http://localhost:${hop1.port}`);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("private") });
    expect(privateAccessed).toBe(0);
  } finally {
    hop1.stop(true);
    hop2.stop(true);
    privateTarget.stop(true);
  }
});

test("stops and rejects when manual redirect loop exceeds limit", async () => {
  let port = 0;
  const loop = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const step = Number(url.searchParams.get("step") ?? "0");
      return Response.redirect(`http://localhost:${port}/redirect?step=${step + 1}`);
    },
  });
  port = loop.port ?? 0;
  try {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    const result = await createFetch(
      { direct: fetchers.direct },
      { store: memoryStore(), env: {}, allowPrivateNetworks: true, resolve },
    ).fetch(`http://localhost:${loop.port}/redirect`);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("too many redirects") });
  } finally {
    loop.stop(true);
  }
});

test("allows following manual redirects to internal endpoints when allowPrivateNetworks is true", async () => {
  const destination = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `<html><head><title>Internal Doc</title></head><body><article><p>${"Internal article text. ".repeat(25)}</p></article></body></html>`,
        { headers: { "content-type": "text/html" } },
      ),
  });
  const gateway = Bun.serve({
    port: 0,
    fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}/doc`),
  });
  try {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    const result = await createFetch(
      { direct: fetchers.direct },
      { store: memoryStore(), env: {}, allowPrivateNetworks: true, resolve },
    ).fetch(`http://localhost:${gateway.port}/start`);

    expect(result).toMatchObject({
      success: true,
      data: {
        url: `http://127.0.0.1:${destination.port}/doc`,
        title: "Internal Doc",
      },
    });
  } finally {
    gateway.stop(true);
    destination.stop(true);
  }
});

test("direct fetch rejects unsupported binary content types like images and octet-streams", async () => {
  const binaryServer = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
        headers: { "content-type": "application/octet-stream" },
      }),
  });
  try {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    const result = await createFetch(
      { direct: fetchers.direct },
      { store: memoryStore(), env: {}, allowPrivateNetworks: true, resolve },
    ).fetch(`http://127.0.0.1:${binaryServer.port}/data.bin`);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("can't read application/octet-stream locally"),
    });
  } finally {
    binaryServer.stop(true);
  }
});

test("marks truncated as false when content length fits within maxCharacters", async () => {
  const result = await setup({ reader: fetcher(page("short body content")) }).fetch("https://a.com", {
    maxCharacters: 500,
  });
  expect(result).toMatchObject({
    success: true,
    data: {
      content: "short body content",
      truncated: false,
    },
  });
});

test("produces clean public page data with trimmed content and correct shape", async () => {
  const messyPage = fetcher({
    url: "https://clean.example/page",
    title: "Clean Public Title",
    content: "   \n\n# Markdown title\n\nContent paragraph.\n   ",
    publishedAt: "2026-04-01",
  });
  const result = await setup({ messyPage }).fetch("https://clean.example/page", { format: "markdown" });

  expect(result).toEqual({
    success: true,
    data: {
      url: "https://clean.example/page",
      title: "Clean Public Title",
      content: "# Markdown title\n\nContent paragraph.",
      publishedAt: "2026-04-01",
      format: "markdown",
      truncated: false,
    },
  });
});

test("normalizes published date formats and rejects invalid dates in pageFromHtml", async () => {
  const htmlWithDate = `<html><head><title>Blog</title>
  <meta property="article:published_time" content="2026-05-10T14:30:00.000Z" />
  </head><body><article><p>${"Blog content sentence here. ".repeat(25)}</p></article></body></html>`;
  const result = await pageFromHtml(htmlWithDate, "https://blog.example/post", "markdown");
  expect(result.publishedAt).toBe("2026-05-10");
});
