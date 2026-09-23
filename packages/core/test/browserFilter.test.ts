import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBrowserFilter, stopBrowserFilter } from "../src/browserFilter";

const serve = `
  const { serveBrowserFilter, FILTER_ENV } = await import(${JSON.stringify(new URL("../src/browserFilter.ts", import.meta.url).href)});
  await serveBrowserFilter(process.env[FILTER_ENV]);
`;
const command = [process.execPath, "-e", serve];
const pidIn = (path: string): number => JSON.parse(readFileSync(path, "utf8")).pid;

test("the CLI browser filter blocks private targets, is reused, and comes back on the same port", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "webmesh-filter-")), "browser-filter.json");
  const destination = Bun.serve({ port: 0, fetch: () => new Response("secret") });
  try {
    const url = await ensureBrowserFilter(command, { directHosts: [], allowedHosts: [] }, path);
    const blocked = await fetch(`http://127.0.0.1:${destination.port}`, { proxy: url });
    expect(blocked.status).toBe(403);

    const firstPid = pidIn(path);
    expect(await ensureBrowserFilter(command, { directHosts: [], allowedHosts: [] }, path)).toBe(url);
    expect(pidIn(path)).toBe(firstPid);
    expect(readFileSync(path, "utf8")).not.toContain("secret-password");

    process.kill(firstPid);
    await Bun.sleep(100);
    expect(await ensureBrowserFilter(command, { directHosts: [], allowedHosts: [] }, path)).toBe(url);
    expect(pidIn(path)).not.toBe(firstPid);

    const changed = await ensureBrowserFilter(command, { upstreamProxy: "http://user:secret-password@proxy.test:8080", directHosts: [], allowedHosts: [] }, path);
    expect(changed).toBe(url);
    expect(readFileSync(path, "utf8")).not.toContain("secret-password");
  } finally {
    stopBrowserFilter(path);
    destination.stop(true);
  }
});
