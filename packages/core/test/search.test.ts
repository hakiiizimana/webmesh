import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/http";
import { memoryStore } from "../src/state";
import type { Provider, SearchFilters, SearchItem } from "../src/types";
import { createSearch } from "../src/webSearch";

const item = (url: string, title = url, description = ""): SearchItem => ({ title, url, description });

function scripted(outcomes: Array<SearchItem[] | Error>, env?: string) {
  const calls: string[] = [];
  const provider: Provider = {
    kind: "api",
    env,
    async search(query) {
      const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)] ?? [];
      calls.push(query);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return Object.assign(provider, { calls });
}

const fake = (result: SearchItem[] | Error, env?: string) => scripted([result], env);

function hung() {
  const cancelled: boolean[] = [];
  const provider: Provider = {
    kind: "public",
    search: (_query, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled.push(true);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  return Object.assign(provider, { cancelled });
}

function setup<R extends Record<string, Provider>>(registry: R, overrides: Partial<Parameters<typeof createSearch>[1]> = {}) {
  return createSearch(registry, { store: memoryStore(), env: {}, random: () => 0, retryDelayMs: 0, ...overrides });
}

describe("search fusion", () => {
  test("collects results concurrently from multiple free providers", async () => {
    const p1 = fake([item("https://first.com/result")]);
    const p2 = fake([item("https://second.com/result")]);
    const p3 = fake([item("https://third.com/result")]);
    const { search } = setup({ p1, p2, p3 });
    const result = await search("concurrent test");

    expect(result.success).toBe(true);
    if (result.success) {
      const urls = result.data.map((entry) => entry.url);
      expect(urls).toContain("https://first.com/result");
      expect(urls).toContain("https://second.com/result");
      expect(urls).toContain("https://third.com/result");
    }
    expect(p1.calls).toHaveLength(1);
    expect(p2.calls).toHaveLength(1);
    expect(p3.calls).toHaveLength(1);
  });

  test("orders merged results using reciprocal-rank fusion", async () => {
    const p1 = fake([
      item("https://alpha.com/solo"),
      item("https://shared.com/item"),
      item("https://alpha.com/tail"),
    ]);
    const p2 = fake([
      item("https://shared.com/item"),
      item("https://beta.com/solo"),
      item("https://beta.com/tail"),
    ]);
    const { search } = setup({ p1, p2 });
    const result = await search("rrf test");

    expect(result.success).toBe(true);
    if (result.success) {
      const urls = result.data.map((entry) => entry.url);
      expect(urls[0]).toBe("https://shared.com/item");
      expect(urls[1]).toBe("https://alpha.com/solo");
      expect(urls[2]).toBe("https://beta.com/solo");
    }
  });

  test("deduplicates canonical URLs across providers", async () => {
    const p1 = fake([
      item("https://example.com/page"),
      item("https://example.com/docs/"),
      item("https://example.com/guide?utm_source=twitter&utm_medium=social"),
      item("https://example.com/about#team"),
    ]);
    const p2 = fake([
      item("https://example.com/page"),
      item("https://example.com/docs"),
      item("https://example.com/guide"),
      item("https://example.com/about"),
      item("https://example.com/unique"),
    ]);
    const { search } = setup({ p1, p2 });
    const result = await search("dedupe test");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(5);
      const urls = result.data.map((entry) => entry.url);
      expect(urls.filter((u) => u.includes("/page"))).toHaveLength(1);
      expect(urls.filter((u) => u.includes("/docs"))).toHaveLength(1);
      expect(urls.filter((u) => u.includes("/guide"))).toHaveLength(1);
      expect(urls.filter((u) => u.includes("/about"))).toHaveLength(1);
      expect(urls.filter((u) => u.includes("/unique"))).toHaveLength(1);
    }
  });

  test("applies domain diversity so a single domain does not crowd out others", async () => {
    const p1 = fake([
      item("https://site-a.com/page-1"),
      item("https://site-a.com/page-2"),
      item("https://site-a.com/page-3"),
      item("https://site-b.com/page-1"),
    ]);
    const { search } = setup({ p1 });
    const result = await search("diversity test");

    expect(result.success).toBe(true);
    if (result.success) {
      const urls = result.data.map((entry) => entry.url);
      const siteBIndex = urls.indexOf("https://site-b.com/page-1");
      const siteAThirdIndex = urls.indexOf("https://site-a.com/page-3");
      expect(siteBIndex).toBeGreaterThanOrEqual(0);
      expect(siteAThirdIndex).toBeGreaterThanOrEqual(0);
      expect(siteBIndex).toBeLessThan(siteAThirdIndex);
    }
  });

  test("cuts off and cancels slow providers while returning fast ones", async () => {
    const slow = hung();
    const fast = fake([item("https://fast.com/result")]);
    const result = await setup({ slow, fast }, { hedgeMs: 10, budgetMs: 20 }).search("cutoff test");

    expect(result).toEqual({
      success: true,
      data: [item("https://fast.com/result")],
    });
    expect(slow.cancelled).toHaveLength(1);
  });

  test("tolerates individual provider failures when other providers answer", async () => {
    const failing = fake(new HttpError(500, undefined, "HTTP 500"));
    const broken = fake(new Error("network failure"));
    const working = fake([item("https://working.com/result")]);
    const result = await setup({ failing, broken, working }).search("tolerance test");

    expect(result).toEqual({
      success: true,
      data: [item("https://working.com/result")],
    });
  });

  test("returns success false when every provider fails", async () => {
    const failing1 = fake(new Error("failure 1"));
    const failing2 = fake(new HttpError(503, undefined, "HTTP 503"));
    const result = await setup({ failing1, failing2 }).search("all fail test");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeString();
    }
  });

  test("returns clean response with only success and data, omitting routing and cache metadata", async () => {
    const p1 = fake([item("https://a.com/one")]);
    const p2 = fake([item("https://b.com/two")]);
    const result = await setup({ p1, p2 }).search("clean response test");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result).sort()).toEqual(["data", "success"]);
      expect(result).not.toHaveProperty("provider");
      expect(result).not.toHaveProperty("attempts");
      expect(result).not.toHaveProperty("routing");
      expect(result).not.toHaveProperty("cached");
    }
  });

  test("caches merged results for subsequent identical searches", async () => {
    let clock = 1000;
    const p1 = fake([item("https://p1.com/result")]);
    const p2 = fake([item("https://p2.com/result")]);
    const { search } = setup({ p1, p2 }, { now: () => clock });

    const first = await search("cache query");
    expect(first.success).toBe(true);
    expect(p1.calls).toHaveLength(1);
    expect(p2.calls).toHaveLength(1);

    const second = await search("cache query");
    expect(second).toEqual(first);
    expect(p1.calls).toHaveLength(1);
    expect(p2.calls).toHaveLength(1);

    clock += 24 * 60 * 60_000 + 1;
    const third = await search("cache query");
    expect(third.success).toBe(true);
    expect(p1.calls).toHaveLength(2);
    expect(p2.calls).toHaveLength(2);
  });

  test("drops results outside requested includeDomains", async () => {
    const p1 = fake([item("https://docs.sqlite.org/wal"), item("https://stackoverflow.com/q/1")]);
    const p2 = fake([item("https://sqlite.org/lang"), item("https://sqlite.org.evil.com/phish")]);
    const result = await setup({ p1, p2 }).search("query", { filters: { includeDomains: ["sqlite.org"] } });

    expect(result).toEqual({
      success: true,
      data: [item("https://docs.sqlite.org/wal"), item("https://sqlite.org/lang")],
    });
  });

  test("respects limit option after merging providers", async () => {
    const p1 = fake([item("https://a.com/1"), item("https://a.com/2")]);
    const p2 = fake([item("https://b.com/1"), item("https://b.com/2")]);
    const result = await setup({ p1, p2 }).search("query", { limit: 2 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
    }
  });

  test("skips providers that cannot honor requested filters", async () => {
    const skipped = Object.assign(fake([item("https://skipped.com/item")]), { supports: () => false });
    const used = fake([item("https://used.com/item")]);
    const result = await setup({ skipped, used }).search("query", { filters: { language: "en" } });

    expect(result).toEqual({ success: true, data: [item("https://used.com/item")] });
    expect(skipped.calls).toHaveLength(0);
    expect(used.calls).toHaveLength(1);
  });

  test("passes filters through to providers and preserves descriptions", async () => {
    const filters: SearchFilters = {
      freshness: "week",
      includeDomains: ["example.com"],
      type: "news",
      exactMatch: true,
    };
    const description = "long result ".repeat(99) + "long result";
    let received: SearchFilters | undefined;
    const provider: Provider = {
      kind: "api",
      async search(_query: string, context: { filters: SearchFilters }) {
        received = context.filters;
        return [{ title: "Result", url: "https://example.com/result", description }];
      },
    };

    const result = await setup({ provider }).search("query", { filters });

    expect(received).toEqual(filters);
    expect(result).toEqual({
      success: true,
      data: [{ title: "Result", url: "https://example.com/result", description }],
    });
  });

  test("sends only scrapers through the proxy", async () => {
    const seen: Record<string, string | undefined> = {};
    const provider = (kind: Provider["kind"], answer: boolean): Provider => ({
      kind,
      async search(_query, context) {
        seen[kind] = context.proxy;
        return answer ? [item("https://x.com")] : [];
      },
    });
    const registry = { scraper: provider("scrape", false), api: provider("public", true) };
    const searcher = setup(registry, { proxy: "http://proxy:8000" });
    await searcher.search("query");

    expect(seen).toEqual({ scrape: "http://proxy:8000", public: undefined });
  });
});
