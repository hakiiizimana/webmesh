import { expect, test } from "bun:test";
import { cleanHtml } from "../src/read/providers/cleanHtml";

const DIRTY = `<!DOCTYPE html><html><head><title>Doc</title>
<link rel="stylesheet" href="/style.css"><style>body{color:red}</style>
<script>alert("x")</script></head><body>
<header id="top">Site header</header>
<nav><a href="/">Home</a></nav>
<main><section class="post" data-id="7"><h2>Hello</h2>
<p onclick="steal()">Body text with a <a href="/rel?q=1">relative link</a>.</p>
<a href="javascript:alert(1)">bad link</a>
<table class="data"><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
<img src="/i.png" onerror="boom()" srcset="/small.png 100w, /big.png 800w">
<iframe src="https://evil.example"></iframe>
<form action="/submit"><input name="q"><button>Go</button></form>
<div class="ad">Buy now</div>
<div class="sidebar">Sidebar chrome</div>
<div class="side">Side note</div>
<div class="language">Code language label</div>
<div class="widget">Embedded widget</div>
<aside class="post-aside">Related reading</aside>
<div style="display:none">hidden by style</div>
<div hidden>hidden attribute</div>
<span aria-hidden="true">decorative</span>
</section></main>
<footer>Site footer</footer></body></html>`;

test("preserves semantic structure, classes, tables, and links", async () => {
  const html = await cleanHtml(DIRTY, "https://site.example/page");
  expect(html).toContain("<main>");
  expect(html).toContain('<section class="post" data-id="7">');
  expect(html).toContain("<th>A</th>");
  expect(html).toContain('<a href="https://site.example/rel?q=1">relative link</a>');
  expect(html).toContain('<img src="https://site.example/big.png"');
});

test("preserves article headers, footers, asides, and ambiguous class names", async () => {
  const html = await cleanHtml(DIRTY, "https://site.example/page");
  expect(html).toContain('<header id="top">Site header</header>');
  expect(html).toContain("<footer>Site footer</footer>");
  expect(html).toContain('<aside class="post-aside">Related reading</aside>');
  expect(html).toContain('<div class="sidebar">Sidebar chrome</div>');
  expect(html).toContain('<div class="side">Side note</div>');
  expect(html).toContain('<div class="language">Code language label</div>');
  expect(html).toContain('<div class="widget">Embedded widget</div>');
  expect(html).toContain('<span aria-hidden="true">decorative</span>');
});

test("removes scripts, styling, navigation, frames, forms, ads, and hidden nodes", async () => {
  const html = await cleanHtml(DIRTY, "https://site.example/page");
  for (const gone of ["<script", "<style", "<link", "<nav", "<iframe", "<form", "<input", "<button", "<title"]) {
    expect(html).not.toContain(gone);
  }
  expect(html).not.toContain("Buy now");
  expect(html).not.toContain("hidden by style");
  expect(html).not.toContain("hidden attribute");
});

test("strips event handler attributes and dangerous URLs", async () => {
  const html = await cleanHtml(DIRTY, "https://site.example/page");
  expect(html).not.toContain("onclick");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("<a>bad link</a>");
});

test("does not convert HTML to Markdown", async () => {
  const html = await cleanHtml(DIRTY, "https://site.example/page");
  expect(html).toContain("<h2>Hello</h2>");
  expect(html).not.toContain("## Hello");
});

test("keeps plain text and entities intact", async () => {
  const html = await cleanHtml(`<body><p>Tom &amp; Jerry &lt;3</p></body>`, "https://site.example/");
  expect(html).toContain("Tom &amp; Jerry &lt;3");
});

const LIBHUNT = await Bun.file(new URL("./fixtures/libhunt.html", import.meta.url)).text();

test("LibHunt fixture keeps article structure and language content", async () => {
  const html = await cleanHtml(LIBHUNT, "https://www.libhunt.com/posts/1540219");
  expect(html).toContain('<article class="post-component"');
  expect(html).toContain('<header class="post-component__header">');
  expect(html).toContain("AI Agents Explained: How They Actually Work");
  expect(html).toContain("This paragraph is the article body");
  expect(html).toContain('<pre><code class="language-go">');
  expect(html).toContain('<div class="side">A side note');
  expect(html).toContain('<div class="widget">An embedded diagram widget');
  expect(html).toContain('<aside class="post-aside" aria-label="Related projects">');
  expect(html).toContain('<a class="repo-component" href="https://www.libhunt.com/r/ollama">ollama</a>');
  expect(html).toContain('<footer class="post-component__footer">');
  expect(html).toContain('<span class="lang-chip">');
});

test("LibHunt fixture drops navigation, ads, modals, scripts, and forms", async () => {
  const html = await cleanHtml(LIBHUNT, "https://www.libhunt.com/posts/1540219");
  expect(html).not.toContain("<nav");
  expect(html).not.toContain("navbar");
  expect(html).not.toContain("breadcrumbs");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<style");
  expect(html).not.toContain("<link");
  expect(html).not.toContain("csrf-token");
  expect(html).not.toContain("Buy this product right now");
  expect(html).not.toContain("Loading...");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<button");
});
