import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserUsage,
  createBrowser,
  parseOutput,
  prepareBrowserCommand,
  redact,
  WEBMESH_BROWSER_COMMANDS,
} from "../src/browser";

const lifecycle = { launched: false, reused: true, restoreStatus: "not_configured" };

test("allows Webmesh browser commands and rejects engine administration", () => {
  expect(prepareBrowserCommand(["open", "https://example.com"])).toEqual({ args: ["open", "https://example.com"] });
  expect(prepareBrowserCommand(["dashboard"])).toHaveProperty("error", expect.stringContaining("Unknown Webmesh browser command"));
});

test("expands shortcuts and drops the flags webmesh sets itself", () => {
  expect(prepareBrowserCommand(["tabs"])).toEqual({ args: ["tab", "list"] });
  expect(prepareBrowserCommand(["inspect", "-c"])).toEqual({ args: ["snapshot", "-i", "-c"] });
  expect(prepareBrowserCommand(["snapshot", "--json", "-i"])).toEqual({ args: ["snapshot", "-i"] });
  expect(prepareBrowserCommand(["snapshot", "--session", "other"])).toHaveProperty("error", expect.stringContaining("--session"));
});

test("refuses flags that would leave the session, proxy, or login store behind", () => {
  const cases = [
    ["open", "https://example.com", "--cdp", "9222"],
    ["open", "https://example.com", "--provider", "browserbase"],
    ["open", "https://example.com", "--profile", "Default"],
    ["open", "https://example.com", "--state", "/tmp/auth.json"],
    ["open", "https://example.com", "--executable-path", "/bin/sh"],
    ["open", "https://example.com", "--allow-file-access"],
    ["open", "https://example.com", "--proxy", "http://127.0.0.1:8080"],
    ["open", "https://example.com", "--ignore-https-errors"],
  ];
  for (const args of cases) {
    expect(prepareBrowserCommand(args)).toHaveProperty("error", expect.stringContaining("is not available through webmesh"));
  }
  expect(prepareBrowserCommand(["open", "https://example.com", "--headed"])).toEqual({
    args: ["open", "https://example.com", "--headed"],
  });
});

test("documents only the commands it accepts", () => {
  const usage = browserUsage();
  const documented = [...usage.matchAll(/webmesh browser ([a-z][\w-]*)/g)].flatMap((match) => match[1] ?? []);

  expect(documented.length).toBeGreaterThan(0);
  for (const command of documented) expect(WEBMESH_BROWSER_COMMANDS).toContain(command);
});

test("does not expose browser installers", () => {
  expect(prepareBrowserCommand(["setup"])).toHaveProperty("error", expect.stringContaining("Unknown Webmesh browser command"));
  expect(prepareBrowserCommand(["install"])).toHaveProperty("error", expect.stringContaining("Unknown Webmesh browser command"));
  expect(prepareBrowserCommand(["upgrade"])).toHaveProperty("error", expect.stringContaining("Unknown Webmesh browser command"));
});

test("keeps what the agent needs from a snapshot and drops the noise", () => {
  const stdout = JSON.stringify({
    success: true,
    data: {
      lifecycle,
      origin: "https://example.com/",
      refs: { e2: { name: "Learn more", role: "link" } },
      snapshot: '- link "Learn more" [ref=e2]',
    },
    error: null,
  });

  expect(parseOutput(stdout, "", 0)).toEqual({
    success: true,
    data: { origin: "https://example.com/", snapshot: '- link "Learn more" [ref=e2]' },
  });
});

test("adds a next step to stale-ref and missing-Chrome errors", () => {
  const stale = parseOutput(JSON.stringify({ success: false, data: null, error: "Unknown ref: e99" }), "", 1);
  const noChrome = parseOutput(JSON.stringify({ success: false, error: 'Failed to launch Chrome at "/x": No such file' }), "", 1);

  expect(stale).toEqual({ success: false, error: "Unknown ref: e99. Refs change when the page changes; run snapshot -i again." });
  expect(!noChrome.success && noChrome.error).toContain("reinstall webmesh.js");
});

test("cuts oversized fields and keeps plain-text output", () => {
  const long = parseOutput(JSON.stringify({ success: true, data: { content: "x".repeat(40_000) } }), "", 0);
  const text = parseOutput("agent-browser 0.38.1\n", "", 0);

  expect(long.success && String(long.data.content).length).toBeLessThan(31_000);
  expect(text).toEqual({ success: true, data: { output: "agent-browser 0.38.1" } });
});

test("redacts cookies, secret fields, tokens in text, and secret URL params", () => {
  const cookies = redact([{ name: "sid", value: "abc123", domain: ".github.com" }]);
  const storage = redact({ theme: "dark", auth_token: "t0k3n" });
  const text = redact("key sk-proj-abcdefghijklmnop1234 and Bearer eyJhbGciOi.xyz and https://app.example/cb?access_token=secret123&page=2");

  expect(cookies).toEqual([{ name: "sid", value: "[redacted]", domain: ".github.com" }]);
  expect(storage).toEqual({ theme: "dark", auth_token: "[redacted]" });
  expect(text).toBe("key [redacted] and [redacted] and https://app.example/cb?access_token=[redacted]&page=2");
});

test("rejects closing every agent-browser session", async () => {
  const browser = createBrowser("webmesh-test");

  expect(await browser.run(["close", "--all"])).toEqual({
    success: false,
    error: "webmesh cannot close browser sessions owned by other agents; drop --all.",
  });
});

test("rejects browser URLs that resolve to private addresses", async () => {
  const browser = createBrowser("webmesh-test", { resolve: async () => [{ address: "127.0.0.1", family: 4 }] });

  expect(await browser.run(["open", "http://internal.example"])).toMatchObject({
    success: false,
    error: expect.stringContaining("private"),
  });
});

test("retries a failed Chromium download instead of caching the error", async () => {
  // Bun.which reads PATH once at startup, and hasSystemBrowser() probes fixed paths on
  // darwin/win32, so the download path needs a child process that looks like linux.
  const ok = join(tmpdir(), `webmesh-install-${crypto.randomUUID()}.mjs`);
  const script = `
    const { ensureBrowser } = await import(${JSON.stringify(new URL("../src/browser.ts", import.meta.url).href)});
    Object.defineProperty(process, "platform", { value: "linux" });
    const ok = ${JSON.stringify(ok)};
    await Bun.write(ok, ""); // any script exiting 0 stands in for a download that worked
    console.log(JSON.stringify({
      failed: (await ensureBrowser("/nonexistent/agent-browser.js")) ?? null,
      retried: (await ensureBrowser(ok)) ?? null,
    }));
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toContain("downloading Chromium");
    expect(JSON.parse(stdout.trim().split("\n").findLast((line) => line.startsWith("{")) ?? "null")).toEqual({
      failed: expect.stringContaining("Could not install Chromium"),
      retried: null, // the failed download was not cached
    });
  } finally {
    await rm(ok, { force: true });
  }
});
