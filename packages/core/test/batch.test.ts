import { expect, test } from "bun:test";
import { createFetch } from "../src/read";
import { createSearch } from "../src/search";
import { mapLimit } from "../src/shared/concurrency";
import { memoryCache, memoryStore } from "../src/state";

const page = (content: string) => ({ url: "https://a.com", title: "A", content, metadata: {} });

const fetchRegistry = () => ({
  direct: {
    kind: "local" as const,
    formats: ["markdown"] as const,
    fetch: async (url: string) => ({ ...page("word ".repeat(30)), url }),
  },
});

const searchRegistry = () => ({
  duckduckgo: {
    kind: "public" as const,
    search: async (query: string) => [{ title: query, url: `https://a.com/${query}`, description: "" }],
  },
});

test("fetchMany returns one labelled result per url", async () => {
  const registry = fetchRegistry();
  const { fetchMany } = createFetch(registry, { store: memoryStore(), cache: memoryCache(), allowPrivateNetworks: true });

  const results = await fetchMany(["https://a.com", "https://b.com", "https://c.com"]);

  expect(results.map((entry) => entry.url)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  expect(results.every((entry) => entry.success)).toBe(true);
});

test("fetchMany keeps a failing url from sinking the rest", async () => {
  const registry = {
    direct: {
      kind: "local" as const,
      formats: ["markdown"] as const,
      fetch: async (url: string) => {
        if (url.includes("bad")) throw new Error("no answer");
        return { ...page("word ".repeat(30)), url };
      },
    },
  };
  const { fetchMany } = createFetch(registry, { store: memoryStore(), cache: memoryCache(), allowPrivateNetworks: true });

  const results = await fetchMany(["https://ok.com", "https://bad.com"]);

  expect(results[0]).toMatchObject({ url: "https://ok.com", success: true });
  expect(results[1]).toMatchObject({ url: "https://bad.com", success: false });
});

test("searchMany returns one labelled result per query", async () => {
  const registry = searchRegistry();
  const { searchMany } = createSearch(registry, { store: memoryStore(), cache: memoryCache() });

  const results = await searchMany(["n8n", "haki"]);

  expect(results.map((entry) => entry.query)).toEqual(["n8n", "haki"]);
  expect(results.every((entry) => entry.success)).toBe(true);
});

test("mapLimit runs everything, never more than the limit at once", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    active -= 1;
    return item * 2;
  });

  expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
  expect(peak).toBeLessThanOrEqual(3);
});
