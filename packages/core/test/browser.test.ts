import { expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adaptBrowserSkill,
  agentBrowserPath,
  browserEnv,
  browserUsage,
  bypassFor,
  cleanEngineOutput,
  cleanEngineStderr,
  createBrowser,
  engineArgs,
  parseOutput,
  prepareBrowserCommand,
  redact,
  savedLoginHosts,
} from "../src/browser";

const lifecycle = { launched: false, reused: true, restoreStatus: "not_configured" };

test("allows every engine command except the ones that leave webmesh's controls", () => {
  const allowed = [
    ["open", "https://example.com"],
    ["dialog", "accept"],
    ["record", "start", "/tmp/take.webm", "--cursor"],
    ["trace", "stop", "/tmp/trace.json"],
    ["mouse", "move", "100", "200"],
    ["dashboard"],
    ["connect", "9222"],
  ];
  for (const args of allowed) expect(prepareBrowserCommand(args)).toEqual({ args });

  expect(prepareBrowserCommand(["connect", "https://remote.example"])).toHaveProperty("error", expect.stringContaining("local debugging port"));
  for (const command of ["plugin", "batch", "auth", "state", "mcp", "upgrade"]) {
    expect(prepareBrowserCommand([command, "x"])).toHaveProperty("error", expect.stringContaining("cannot"));
  }
});

test("drops harmless format and upstream-skill session flags", () => {
  expect(prepareBrowserCommand(["snapshot", "--json", "-i"])).toEqual({ args: ["snapshot", "-i"] });
  expect(prepareBrowserCommand(["--session", "other", "snapshot", "-i"])).toEqual({ args: ["snapshot", "-i"] });
});

test("refuses flags that would leave the session, proxy, or login store behind", () => {
  const cases = [
    ["open", "https://example.com", "--cdp", "9222"],
    ["open", "https://example.com", "--provider", "browserbase"],
    ["open", "https://example.com", "-p", "ios"],
    ["open", "https://example.com", "--profile", "Default"],
    ["open", "https://example.com", "--state", "/tmp/auth.json"],
    ["open", "https://example.com", "--executable-path", "/bin/sh"],
    ["open", "https://example.com", "--allow-file-access"],
    ["open", "https://example.com", "--proxy", "http://127.0.0.1:8080"],
    ["open", "https://example.com", "--ignore-https-errors"],
    ["doctor", "--fix"],
  ];
  for (const args of cases) {
    expect(prepareBrowserCommand(args)).toHaveProperty("error", expect.stringContaining("is not available through webmesh"));
  }
  expect(prepareBrowserCommand(["-p", "agentcore", "open", "https://example.com"])).toEqual({
    args: ["-p", "agentcore", "open", "https://example.com"],
  });
  expect(prepareBrowserCommand(["open", "https://example.com", "--headed"])).toEqual({
    args: ["open", "https://example.com", "--headed"],
  });
});

test("serves the engine's own command list with the refused ones stripped", async () => {
  const bin = agentBrowserPath();
  expect(bin).not.toBeNull();
  const usage = await browserUsage(bin ?? "");

  expect(usage).toContain("record");
  expect(usage).toContain("skills get agent-browser");
  expect(usage).not.toContain("skills get core");
  expect(usage).toContain("webmesh agent-browser");
  expect(usage).not.toContain("AGENT_BROWSER_");
  expect(usage).not.toMatch(/(?:^|\s)-p(?:\s|,|$)/);
  expect(usage).toMatch(/^  connect <local-port>/m);
  expect(usage).not.toContain("skills path");
  for (const command of ["plugin", "batch", "auth", "state", "mcp", "upgrade"]) {
    expect(usage).not.toMatch(new RegExp(`^[ \\t]*${command}\\b`, "m"));
  }

  // Install lines keep the real package name, so they must still say agent-browser.
  expect(usage).toContain("npm install -g agent-browser");
  expect(usage).not.toContain("npm install -g webmesh agent-browser");
});

test("pins an empty engine config instead of loading user or project overrides", async () => {
  const args = engineArgs("/tmp/agent-browser", ["session"]);
  const config = args[args.indexOf("--config") + 1];

  expect(config).toEndWith("webmesh-agent-browser-config.json");
  expect(JSON.parse(await Bun.file(config ?? "").text())).toEqual({});
});

test("allows a workspace init script but not a path outside the workspace", async () => {
  const script = join(process.cwd(), `.webmesh-init-${crypto.randomUUID()}.js`);
  await Bun.write(script, "window.__webmesh = true;");
  try {
    expect(prepareBrowserCommand(["--init-script", script, "open", "https://example.com"])).toEqual({
      args: ["--init-script", script, "open", "https://example.com"],
    });
    expect(prepareBrowserCommand(["--init-script", "/tmp/outside.js", "open", "https://example.com"])).toHaveProperty(
      "error",
      expect.stringContaining("current workspace"),
    );
  } finally {
    await rm(script, { force: true });
  }
});

test("adapts every bundled upstream skill without broken webmesh commands", async () => {
  const skillRoot = join(dirname(Bun.resolveSync("agent-browser/package.json", import.meta.dir)), "skill-data");
  const adapted = new Map<string, string>();
  for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = entry.name === "core"
      ? await Bun.file(join(import.meta.dir, "../../../skills/agent-browser/SKILL.md")).text()
      : await Bun.file(join(skillRoot, entry.name, "SKILL.md")).text();
    adapted.set(entry.name, adaptBrowserSkill(entry.name, source));
  }

  expect(adapted.get("dogfood")).not.toContain("--session");
  expect(adapted.get("dogfood")).not.toContain("state save");
  expect(adapted.get("dogfood")).not.toContain("{SKILL_DIR}");
  expect(adapted.get("electron")).toContain("webmesh agent-browser connect 9222");
  expect(adapted.get("electron")).not.toContain("--cdp");
  expect(adapted.get("agentcore")).toContain("webmesh agent-browser -p agentcore open");
  expect(adapted.get("protected-vercel-deployments")).toContain("Bash(webmesh:*), Bash(vc:*), Bash(vercel:*)");
  expect(adapted.get("webmcp-gen")).toContain("webmesh agent-browser --init-script");
  expect(adapted.get("vercel-sandbox")).toContain('sandbox.runCommand("agent-browser"');
});

test("strips the engine's env twins of the flags webmesh refuses", () => {
  process.env.AGENT_BROWSER_SESSION = "stolen";
  process.env.AGENT_BROWSER_STATE = "/tmp/auth.json";
  try {
    const env = browserEnv(undefined);

    expect(env.AGENT_BROWSER_SESSION).toBeUndefined();
    expect(env.AGENT_BROWSER_STATE).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  } finally {
    delete process.env.AGENT_BROWSER_SESSION;
    delete process.env.AGENT_BROWSER_STATE;
  }
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
  expect(!noChrome.success && noChrome.error).toContain("Install Chrome or Chromium");
});

test("cuts oversized fields and keeps plain-text output", () => {
  const long = parseOutput(JSON.stringify({ success: true, data: { content: "x".repeat(40_000) } }), "", 0);
  const text = parseOutput("agent-browser 0.38.1\n", "", 0);

  expect(long.success && String(long.data.content).length).toBeLessThan(31_000);
  expect(text).toEqual({ success: true, data: { output: "webmesh agent-browser 0.38.1" } });
});

test("a line that only looks like JSON is read as text, not thrown", () => {
  expect(parseOutput("{ not json", "", 0)).toEqual({ success: true, data: { output: "{ not json" } });
  expect(parseOutput("{ not json", "boom: crashed", 1)).toEqual({ success: false, error: "boom: crashed" });
});

test("hides which engine webmesh drives", () => {
  expect(cleanEngineOutput("allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)")).toBe("allowed-tools: Bash(webmesh:*)");
  expect(cleanEngineOutput("Use agent-browser directly, never npx agent-browser.")).toBe("Use webmesh agent-browser directly, never npx agent-browser.");
  expect(cleanEngineStderr("[agent-browser] launched browser; restore: loaded")).toBe("[webmesh agent-browser] launched browser; restore: loaded");
  expect(cleanEngineStderr("[agent-browser] restore: loaded; save: disabled")).toBe("[webmesh agent-browser] restore: loaded; save: disabled");
  expect(cleanEngineStderr("[agent-browser] Warning: CDP event buffer overflowed")).toBe("[webmesh agent-browser] Warning: CDP event buffer overflowed");
  expect(cleanEngineStderr("Usage: agent-browser set headers <json>")).toBe("Usage: webmesh agent-browser set headers <json>");
  expect(cleanEngineStderr("/x/node_modules/agent-browser/bin/agent-browser.js")).toBe("/x/node_modules/agent-browser/bin/agent-browser.js");
  expect(cleanEngineStderr("✗ Unknown ref: e999")).toBe("✗ Unknown ref: e999");

  const failed = parseOutput("", "[agent-browser] launched browser\nboom: no such element\n", 1);
  expect(failed).toEqual({ success: false, error: "boom: no such element" });
});

test("allows page diagnostics and the credential-injection path", () => {
  const allowed = [
    ["console"],
    ["errors"],
    ["eval", "document.title"],
    ["pushstate", "/next"],
    ["set", "viewport", "390", "844"],
    ["set", "headers", '{"Authorization":"Bearer t"}'],
    ["set", "credentials", "user", "pass"],
  ];
  for (const args of allowed) expect(prepareBrowserCommand(args)).toEqual({ args });

  expect(prepareBrowserCommand(["eval", "--proxy", "http://elsewhere"])).toHaveProperty("error", expect.stringContaining("--proxy"));
});

test("reports saved login hosts without the proxy wildcards", () => {
  const state = JSON.stringify({
    cookies: [{ domain: ".github.com" }, { domain: "app.example.com" }],
    origins: [{ origin: "https://api.example.com" }],
  });

  expect(savedLoginHosts([state])).toEqual(["api.example.com", "app.example.com", "github.com"]);
  expect(bypassFor([state])).toContain("*.github.com");
  expect(savedLoginHosts(["not json"])).toBeUndefined();
});

test("surfaces whether the saved login came back", () => {
  const restored = parseOutput(JSON.stringify({ success: true, data: { lifecycle: { restoreStatus: "loaded" }, title: "x" } }), "", 0);
  const none = parseOutput(JSON.stringify({ success: true, data: { lifecycle: { restoreStatus: "not_configured" }, title: "x" } }), "", 0);

  expect(restored.success && restored.data.restoreStatus).toBe("loaded");
  expect(none.success && "restoreStatus" in none.data).toBe(false);
});

test("redacts cookies, secret fields, tokens in text, and secret URL params", () => {
  const cookies = redact([{ name: "sid", value: "abc123", domain: ".github.com" }]);
  const storage = redact({ theme: "dark", auth_token: "t0k3n" });
  const text = redact("key sk-proj-abcdefghijklmnop1234 and Bearer eyJhbGciOi.xyz and https://app.example/cb?access_token=secret123&page=2");
  const assignment = redact("session_id=supersecret123; theme=dark");

  expect(cookies).toEqual([{ name: "sid", value: "[redacted]", domain: ".github.com" }]);
  expect(storage).toEqual({ theme: "dark", auth_token: "[redacted]" });
  expect(text).toBe("key [redacted] and [redacted] and https://app.example/cb?access_token=[redacted]&page=2");
  expect(assignment).toBe("session_id=[redacted]; theme=dark");
});

test("does not redact words that only start like a secret", () => {
  expect(redact("violations: 0  incomplete: 1  passes: 42")).toBe("violations: 0  incomplete: 1  passes: 42");
  expect(redact({ author: "Ada", passes: 3 })).toEqual({ author: "Ada", passes: 3 });
  expect(redact("author: Ada; authority=root")).toBe("author: Ada; authority=root");
  expect(redact("password: hunter2 db_pass=x auth=y")).toBe("password: [redacted] db_pass=[redacted] auth=[redacted]");
  expect(redact({ pass: "x", passwd: "y", authToken: "z" })).toEqual({ pass: "[redacted]", passwd: "[redacted]", authToken: "[redacted]" });
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
