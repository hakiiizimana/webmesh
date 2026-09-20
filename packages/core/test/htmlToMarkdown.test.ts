import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { convertHtmlToMarkdown, htmlToMarkdownPath, runHtmlToMarkdown } from "../src/read/providers/htmlToMarkdown";

const makeFake = async (body: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "webmesh-html2md-"));
  const path = join(directory, "html-to-markdown");
  await Bun.write(path, `#!/usr/bin/env bun\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

const withFake = async (body: string, run: (path: string) => Promise<void>): Promise<void> => {
  const path = await makeFake(body);
  try {
    await run(path);
  } finally {
    await rm(join(path, ".."), { recursive: true, force: true });
  }
};

test("ships a binary named for every supported platform", () => {
  const bin = join(import.meta.dir, "..", "bin");
  if (!existsSync(bin)) return;
  const names = new Set(readdirSync(bin));
  const expected = [
    "html-to-markdown-linux-x64",
    "html-to-markdown-linux-arm64",
    "html-to-markdown-darwin-x64",
    "html-to-markdown-darwin-arm64",
    "html-to-markdown-win32-x64.exe",
    "html-to-markdown-win32-arm64.exe",
  ];
  for (const name of expected) expect(names.has(name)).toBe(true);
});

test("locates a bundled binary for this platform", () => {
  const path = htmlToMarkdownPath();
  if (path === null) return;
  expect(path).toContain(`html-to-markdown-${process.platform}-${process.arch}`);
  expect(Bun.file(path).size).toBeGreaterThan(0);
});

test("round-trips html through the binary on stdin and stdout", async () => {
  await withFake('const text = await Bun.stdin.text(); process.stdout.write(text.toUpperCase());', async (path) => {
    expect(await runHtmlToMarkdown("hello", { executablePath: path })).toEqual({ success: true, markdown: "HELLO" });
  });
});

test("reports a non-zero exit with its stderr", async () => {
  await withFake('process.stderr.write("boom\\n"); process.exit(3);', async (path) => {
    const result = await runHtmlToMarkdown("x", { executablePath: path });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe("exit");
    expect(result.error.exitCode).toBe(3);
    expect(result.error.message).toBe("boom");
  });
});

test("bounds input before spawning", async () => {
  const result = await runHtmlToMarkdown("x".repeat(64), { maxInputBytes: 16 });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.kind).toBe("input-limit");
});

test("bounds output and kills the process", async () => {
  await withFake('process.stdout.write("x".repeat(100000));', async (path) => {
    const result = await runHtmlToMarkdown("x", { executablePath: path, maxOutputBytes: 1000 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe("output-limit");
  });
});

test("times out a wedged binary", async () => {
  await withFake("await Bun.sleep(5000);", async (path) => {
    const result = await runHtmlToMarkdown("x", { executablePath: path, timeoutMs: 50 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe("timeout");
  });
});

test("cancels a running binary through the abort signal", async () => {
  await withFake("await Bun.sleep(5000);", async (path) => {
    const controller = new AbortController();
    const running = runHtmlToMarkdown("x", { executablePath: path, signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    const result = await running;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe("cancelled");
  });
});

test("falls back to Defuddle markdown when the binary fails or returns nothing", async () => {
  await withFake("process.exit(2);", async (path) => {
    expect(await convertHtmlToMarkdown("<p>x</p>", "fallback", { executablePath: path })).toBe("fallback");
  });
  await withFake("process.exit(0);", async (path) => {
    expect(await convertHtmlToMarkdown("<p>x</p>", "fallback", { executablePath: path })).toBe("fallback");
  });
});

test.skipIf(htmlToMarkdownPath() === null)("converts tables, nested lists, and fenced code with the real binary", async () => {
  const html = `<h1>Doc</h1>
<ul><li>one<ul><li>one.a</li></ul></li></ul>
<pre><code class="language-go">fmt.Println("hi")</code></pre>
<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`;
  const result = await runHtmlToMarkdown(html);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.markdown).toContain("- one");
  expect(result.markdown).toContain("  - one.a");
  expect(result.markdown).toContain("```go");
  expect(result.markdown).toContain("| A | B |");
  expect(result.markdown).toContain("| --- | --- |");
  expect(result.markdown).toContain("| 1 | 2 |");
});
