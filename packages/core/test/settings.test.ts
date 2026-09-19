import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bypassFor } from "../src/browser";
import { request } from "../src/http";
import { loadSettings, maskProxy, mergeEnv, saveSettings } from "../src/settings";

test("saves settings only the owner can read, and agent env beats the file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "webmesh-")), "config.json");
  saveSettings({ keys: { EXA_API_KEY: "from-file", TAVILY_API_KEY: "from-file" }, proxy: "http://u:p@proxy.example:8000" }, path);

  const settings = loadSettings(path);
  const env = mergeEnv(settings.keys, { EXA_API_KEY: "from-agent", TAVILY_API_KEY: "" });

  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect([env.EXA_API_KEY, env.TAVILY_API_KEY]).toEqual(["from-agent", "from-file"]);
  expect(maskProxy(settings.proxy ?? "")).toBe("http://u:***@proxy.example:8000/");
});

test("sends requests through the proxy with both fetch and the browser-like client", async () => {
  const seen: string[] = [];
  const proxy = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.url);
      return new Response("via proxy");
    },
  });
  try {
    const url = `http://localhost:${proxy.port}`;
    const signal = AbortSignal.timeout(5_000);
    const plain = await request("http://webmesh.invalid/plain", { signal, proxy: url });
    const browser = await request("http://webmesh.invalid/browser", { signal, proxy: url, browser: true });

    expect([await plain.text(), await browser.text()]).toEqual(["via proxy", "via proxy"]);
    expect(seen.map((u) => new URL(u).pathname)).toEqual(["/plain", "/browser"]);
  } finally {
    proxy.stop(true);
  }
});

test("keeps every site you logged into off the proxy, and fails direct on a state it can't read", () => {
  const state = JSON.stringify({ cookies: [{ domain: ".github.com" }], origins: [{ origin: "https://app.linear.app" }] });

  expect(bypassFor([state])).toEqual(["app.linear.app", "*.app.linear.app", "github.com", "*.github.com"]);
  expect(bypassFor(["encrypted:abc"])).toBeUndefined();
});
