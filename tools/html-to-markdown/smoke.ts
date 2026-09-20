import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const bin = process.env.WEBMESH_SMOKE_BIN;
if (!bin) throw new Error("WEBMESH_SMOKE_BIN is not set");

const PAGE = `<!DOCTYPE html><html><head><title>Smoke | Page</title>
<style>body{}</style><script>alert(1)</script></head><body>
<header>Site header</header><nav><a href="/">Home</a></nav>
<main><article class="post"><h1>Smoke page</h1>
<p>This paragraph exists only to satisfy the minimum word count so the extraction pipeline keeps the main content around for the smoke test.</p>
<ul><li><input type="checkbox" checked> done task</li><li><input type="checkbox"> open task</li></ul>
<table class="data"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
</article></main>
<footer>Site footer</footer></body></html>`;

const server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
const configDir = join(process.env.TMPDIR ?? "/tmp", `webmesh-smoke-config-${process.pid}`);
mkdirSync(join(configDir, "webmesh"), { recursive: true });
writeFileSync(join(configDir, "webmesh", "config.json"), JSON.stringify({ keys: {}, allowPrivateNetworks: true }));

const run = async (args: string[]) => {
  const proc = Bun.spawn([bin, ...args], { env: { ...process.env, XDG_CONFIG_HOME: configDir }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

try {
  const markdown = await run(["fetch", `http://127.0.0.1:${server.port}/`, "--format", "markdown"]);
  check("markdown exit", markdown.code === 0, markdown.stderr);
  check("markdown task list from the Go converter", markdown.stdout.includes("- [x]  done task"), markdown.stdout);
  check("markdown table", markdown.stdout.includes("| A | B |"), markdown.stdout);
  check("markdown drops scripts", !markdown.stdout.includes("alert(1)"));

  const html = await run(["fetch", `http://127.0.0.1:${server.port}/`, "--format", "html"]);
  check("html exit", html.code === 0, html.stderr);
  check("html keeps classes", html.stdout.includes("post"), html.stdout);
  check("html keeps tables", html.stdout.includes("<table"), html.stdout);
  check("html drops scripts", !html.stdout.includes("alert(1)"));
  check("html drops nav", !html.stdout.includes("<nav"));
} finally {
  server.stop(true);
}

if (failures.length > 0) {
  console.error("SMOKE FAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("installed artifact smoke test passed");
