import { describe, expect, test } from "bun:test";
import { SoftBlockError } from "../src/html";
import { HttpError, NetworkError } from "../src/http";
import { createSearch } from "../src/webSearch";
import { memoryStore } from "../src/state";
import type { Provider, SearchFilters, SearchItem } from "../src/types";

const item = (url: string): SearchItem => ({ title: url, url, description: "" });

/** A provider that plays its outcomes in order, repeating the last one. */
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

/** A provider that never answers; it settles only when the search cancels it. */
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

/** Deterministic router: equal history keeps registry order, and retries don't wait. */
function setup<R extends Record<string, Provider>>(registry: R, overrides: Partial<Parameters<typeof createSearch>[1]> = {}) {
  return createSearch(registry, { store: memoryStore(), env: {}, random: () => 0, retryDelayMs: 0, ...overrides });
}

describe("router", () => {
  test("tries free providers before keyed ones", async () => {
    const registry = { keyed: fake([item("https://k.com")], "KEY"), free: fake([item("https://f.com")]) };
    const result = await setup(registry, { env: { KEY: "k" } }).search("q");

    expect(result).toEqual({ success: true, provider: "free", attempts: [], data: [item("https://f.com")] });
    expect(registry.keyed.calls).toHaveLength(0);
  });

  test("favors providers that have been answering", async () => {
    const registry = { empty: fake([]), good: fake([item("https://g.com")]) };
    const { search } = setup(registry, { random: () => 0.5 });

    await search("q-1");
    await search("q-2");

    expect(registry.empty.calls).toHaveLength(1);
    expect(registry.good.calls).toHaveLength(2);
  });

  test("starts the next provider alongside a slow one and cancels the loser", async () => {
    const slow = hung();
    const fast = fake([item("https://fast.com")]);
    const result = await setup({ slow, fast }, { hedgeMs: 10 }).search("q");

    expect(result).toEqual({ success: true, provider: "fast", attempts: [], data: [item("https://fast.com")] });
    expect(slow.cancelled).toHaveLength(1);
  });

  test("status reports health once a provider has been tried", async () => {
    const registry = { tried: fake([item("https://t.com")]), untried: fake([]) };
    const router = setup(registry);
    await router.search("q");

    const [tried, untried] = router.status();
    expect(tried).toMatchObject({ id: "tried", successRate: 1 });
    expect(tried?.latencyMs).toBeNumber();
    expect(untried).toMatchObject({ id: "untried", successRate: null, latencyMs: null });
  });

  test("gives up when the time budget runs out", async () => {
    const result = await setup({ slow: hung() }, { budgetMs: 20 }).search("q");
    expect(result).toEqual({ success: false, error: "All providers failed. slow: timed out" });
  });

  test("retries once only on network errors and 5xx", async () => {
    const cases: Array<[Error, number]> = [
      [new NetworkError("connection reset"), 2],
      [new HttpError(503, undefined, "HTTP 503"), 2],
      [new HttpError(202, undefined, "HTTP 202"), 1],
      [new HttpError(403, undefined, "HTTP 403"), 1],
      [new HttpError(429, 5, "HTTP 429"), 1],
      [new SoftBlockError("soft-blocked"), 1],
      [new Error("bad JSON"), 1],
    ];
    for (const [error, calls] of cases) {
      const flaky = scripted([error, [item("https://ok.com")]]);
      const result = await setup({ flaky }).search("q");
      expect(flaky.calls).toHaveLength(calls);
      expect(result.success).toBe(calls === 2);
    }
  });

  test("a failing provider is skipped within the search and benched for later ones", async () => {
    let clock = 0;
    const registry = {
      a: fake(new HttpError(429, 5, "HTTP 429")),
      b: fake([item("https://b.com")]),
    };
    const { search } = setup(registry, { now: () => clock });

    expect(await search("q-1")).toEqual({
      success: true,
      provider: "b",
      attempts: ["a: HTTP 429"],
      data: [item("https://b.com")],
    });
    await search("q-2");
    expect(registry.a.calls).toHaveLength(1);

    clock = 5_001;
    await search("q-3", { only: ["a"] });
    expect(registry.a.calls).toHaveLength(2);
  });

  test("uses the agreed TTL for each freshness window", async () => {
    const cases: Array<{ filters: SearchFilters; ttl: number }> = [
      { filters: {}, ttl: 20 * 60_000 },
      { filters: { freshness: "day" }, ttl: 20 * 60_000 },
      { filters: { freshness: "week" }, ttl: 60 * 60_000 },
      { filters: { freshness: "month" }, ttl: 24 * 60 * 60_000 },
      { filters: { freshness: "year" }, ttl: 24 * 60 * 60_000 },
    ];

    for (const [index, testCase] of cases.entries()) {
      let clock = 0;
      const registry = { a: fake([item(`https://${index}.com`)]) };
      const { search } = setup(registry, { now: () => clock });

      await search(`q-${index}`, { filters: testCase.filters });
      clock = testCase.ttl - 1;
      await search(`q-${index}`, { filters: testCase.filters });
      expect(registry.a.calls).toHaveLength(1);

      clock = testCase.ttl;
      await search(`q-${index}`, { filters: testCase.filters });
      expect(registry.a.calls).toHaveLength(2);
    }
  });

  test("keeps separate cache entries for different filters", async () => {
    const registry = { a: fake([item("https://a.com")]) };
    const { search } = setup(registry);

    await search("q", { filters: { type: "web" } });
    await search("q", { filters: { type: "news" } });

    expect(registry.a.calls).toHaveLength(2);
  });

  test("keyed providers only join when their env var is set", async () => {
    const registry = { keyed: fake([item("https://k.com")], "KEY"), free: fake([item("https://f.com")]) };
    const { search } = setup(registry);
    await search("q");
    await search("q");
    expect(registry.keyed.calls).toHaveLength(0);
  });

  test("returns success false when every provider fails or finds nothing", async () => {
    const registry = { a: fake([]), b: fake(new Error("boom")) };
    const result = await setup(registry).search("q");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("a: no results");
  });

  test("passes filters through and keeps the complete description", async () => {
    const filters: SearchFilters = {
      freshness: "week",
      includeDomains: ["example.com"],
      type: "news",
      exactMatch: true,
    };
    const description = "long result ".repeat(99) + "long result";
    let received: SearchFilters | undefined;
    const registry = {
      a: {
        kind: "api" as const,
        async search(_query: string, context: { filters: SearchFilters }) {
          received = context.filters;
          return [{ title: "Result", url: "https://example.com", description }];
        },
      },
    };

    const result = await setup(registry).search("q", { filters });

    expect(received).toEqual(filters);
    expect(result).toEqual({
      success: true,
      provider: "a",
      attempts: [],
      data: [{ title: "Result", url: "https://example.com", description }],
    });
  });

  test("skips providers that cannot honor requested filters", async () => {
    const skipped = Object.assign(fake([item("https://skipped.com")]), { supports: () => false });
    const used = fake([item("https://used.com")]);
    const result = await setup({ skipped, used }).search("q", { filters: { language: "en" } });

    expect(result).toEqual({ success: true, provider: "used", attempts: [], data: [item("https://used.com")] });
    expect(skipped.calls).toHaveLength(0);
    expect(used.calls).toHaveLength(1);
  });

  test("filters set to their defaults do not rule providers out", async () => {
    const plain = Object.assign(fake([item("https://p.com")]), {
      supports: (filters: SearchFilters) => Object.keys(filters).length === 0,
    });
    const result = await setup({ plain }).search("q", { filters: { type: "web", searchDepth: "fast" } });

    expect(result).toEqual({ success: true, provider: "plain", attempts: [], data: [item("https://p.com")] });
  });
});
