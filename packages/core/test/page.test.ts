import { expect, test } from "bun:test";
import { normalizePage, pageFromHtml } from "../src/read/providers/page";
import { TargetError } from "../src/router";

const ARTICLE = `<html><head><title>WAL mode | SQLite Notes</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About us and our sponsors</a></nav>
<article class="post"><h1>WAL mode</h1>
<p>Write-ahead logging lets readers keep reading while a single writer appends changes to a separate log file,
and a checkpoint later folds those changes back into the main database file without blocking readers.</p>
<pre><code class="language-sql">PRAGMA journal_mode = WAL;</code></pre>
</article></body></html>`;

test("markdown mode converts main content to markdown", async () => {
  const page = await pageFromHtml(ARTICLE, "https://notes.example/wal", "markdown");
  expect(page.title).toBe("WAL mode | SQLite Notes");
  expect(page.content).toContain("## WAL mode");
  expect(page.content).toContain("```sql");
  expect(page.content).not.toContain("<p>");
  expect(page.content).not.toContain("sponsors");
});

test("html mode returns cleaned html, not markdown", async () => {
  const page = await pageFromHtml(ARTICLE, "https://notes.example/wal", "html");
  expect(page.title).toBe("WAL mode | SQLite Notes");
  expect(page.content).toContain('<article class="post">');
  expect(page.content).toContain("<pre>");
  expect(page.content).not.toContain("<nav>");
  expect(page.content).not.toContain("## WAL mode");
});

test("normalizePage cleans html returned by a reader without dropping structure", async () => {
  const page = await normalizePage(
    { url: "https://a.com", title: "A", content: `<body><script>x</script><main><p class="lead">Hi</p></main></body>` },
    "html",
  );
  expect(page.content).toContain('<p class="lead">Hi</p>');
  expect(page.content).not.toContain("<script");
});

test("normalizePage converts html to markdown when markdown is requested", async () => {
  const page = await normalizePage({ url: "https://a.com", title: "A", content: ARTICLE }, "markdown");
  expect(page.content).toContain("## WAL mode");
});

test("normalizePage leaves non-html markdown untouched", async () => {
  const markdown = "# Title\n\n- one\n- two";
  const page = await normalizePage({ url: "https://a.com", title: "A", content: markdown }, "markdown");
  expect(page.content).toBe(markdown);
});

test("normalizePage rejects anti-bot pages", async () => {
  await expect(
    normalizePage({ url: "https://a.com", title: "A", content: "<p>Just a moment...</p>" }, "html"),
  ).rejects.toThrow(TargetError);
});
