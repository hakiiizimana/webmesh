import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/http";
import { createSearch } from "../src/webSearch";
import { memoryStore } from "../src/state";
import type { Provider, SearchItem } from "../src/types";

const item = (url: string): SearchItem => ({ title: url, url, description: "" });

function fake(result: SearchItem[] | Error, env?: string) {
  const calls: string[] = [];
  const provider: Provider = {
    kind: "api",
    env,
    async search(query) {
      calls.push(query);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return Object.assign(provider, { calls });
}

describe("round robin", () => {
  test("each search starts at the provider after the last one that answered", async () => {
    const registry = { a: fake([item("https://a.com")]), b: fake([item("https://b.com")]), c: fake([item("https://c.com")]) };
    const { search } = createSearch(registry, { store: memoryStore(), env: {} });

    const urls: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await search("q");
      if (result.success) urls.push(result.data[0]?.url ?? "");
    }
    expect(urls).toEqual(["https://a.com", "https://b.com", "https://c.com", "https://a.com"]);
  });

  test("a failing provider is skipped within the search and benched for later ones", async () => {
    let clock = 0;
    const registry = {
      a: fake(new HttpError(429, 5, "HTTP 429")),
      b: fake([item("https://b.com")]),
    };
    const { search } = createSearch(registry, { store: memoryStore(), env: {}, now: () => clock });

    expect(await search("q")).toEqual({ success: true, data: [item("https://b.com")] });
    await search("q");
    expect(registry.a.calls).toHaveLength(1);

    clock = 5_001;
    await search("q");
    expect(registry.a.calls).toHaveLength(2);
  });

  test("keyed providers only join when their env var is set", async () => {
    const registry = { keyed: fake([item("https://k.com")], "KEY"), free: fake([item("https://f.com")]) };
    const { search } = createSearch(registry, { store: memoryStore(), env: {} });
    await search("q");
    await search("q");
    expect(registry.keyed.calls).toHaveLength(0);
  });

  test("returns success false when every provider fails or finds nothing", async () => {
    const registry = { a: fake([]), b: fake(new Error("boom")) };
    const result = await createSearch(registry, { store: memoryStore(), env: {} }).search("q");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("a: no results");
  });
});
