import { expect, test } from "bun:test";
import { createFetch } from "../src/read";
import { createRouter } from "../src/router";
import { pageFromHtml } from "../src/read/providers/page";
import { memoryCache, memoryStore } from "../src/state";
import { cacheKey, cachedFetch } from "../src/read/cache";

const page = {
  url: "https://example.com",
  title: "Example",
  content: "word ".repeat(40),
  format: "markdown" as const,
  truncated: false,
  metadata: {
    sourceURL: "https://example.com",
    url: "https://example.com",
    title: "Example",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    contentHash: "sha256:abc",
    statusCode: 200,
  },
};

test("a cached page survives validation and junk does not", () => {
  expect(cachedFetch.safeParse({ success: true, data: page }).data).toEqual({ success: true, data: page });
  expect(cachedFetch.safeParse({ success: true }).success).toBe(false);
  expect(cachedFetch.safeParse({ success: true, data: { ...page, content: 1 } }).success).toBe(false);
});

test("a video page keeps its media metadata through the cache", () => {
  const media = {
    id: "demo",
    site: "youtube.com",
    extractor: "Youtube",
    mediaType: "video" as const,
    title: "Demo",
    description: "",
    url: "https://www.youtube.com/watch?v=demo",
    creator: null,
    creatorId: null,
    creatorUrl: null,
    publishedAt: "2026-01-01",
    durationSeconds: 12,
    thumbnail: null,
    engagement: { views: 3, likes: null, comments: null, reposts: null },
    tags: [],
    categories: [],
    chapters: [],
    captions: [],
    transcript: "hello",
    liveStatus: null,
    availability: null,
    ageLimit: null,
  };
  const cache = memoryCache();
  cache.write("video", { success: true, data: { ...page, media } }, 1);

  expect(cache.read("video", cachedFetch, 0)).toEqual({ success: true, data: { ...page, media } });
});

test("the cache key separates what changes the result", () => {
  const base = cacheKey("https://example.com", ["markdown"], undefined, 50_000, undefined);
  expect(cacheKey("https://example.com", ["markdown"], undefined, 50_000, undefined)).toBe(base);
  expect(cacheKey("https://example.com", ["html"], undefined, 50_000, undefined)).not.toBe(base);
  expect(cacheKey("https://example.com", ["markdown"], undefined, 1_000, undefined)).not.toBe(base);
  expect(cacheKey("https://example.com", ["markdown"], undefined, 50_000, ["direct"])).not.toBe(base);
  expect(cacheKey("https://example.com", ["html", "markdown"], undefined, 50_000, undefined)).toBe(
    cacheKey("https://example.com", ["markdown", "html"], undefined, 50_000, undefined),
  );
});

test("a repeated fetch is served from the cache", async () => {
  let calls = 0;
  const registry = {
    direct: {
      kind: "local" as const,
      formats: ["markdown"] as const,
      fetch: async (url: string) => {
        calls += 1;
        return { url, title: "Example", content: "word ".repeat(40), metadata: {} };
      },
    },
  };

  const engine = createFetch(registry, { store: memoryStore(), cache: memoryCache(), allowPrivateNetworks: true });
  const first = await engine.fetch("https://example.com", {});
  const second = await engine.fetch("https://example.com", {});

  expect(first.success).toBe(true);
  expect(second).toEqual(first);
  expect(calls).toBe(1);

  await engine.fetch("https://example.com", { maxCharacters: 1_000 });
  expect(calls).toBe(2);
});

test("a remote provider that never answers is cut off and benched", async () => {
  const store = memoryStore();
  const router = createRouter(
    "fetch",
    { wayback: { kind: "public" as const, env: "WAYBACK_KEY" } },
    { store, attemptMs: 60, random: () => 0.5 },
    { budgetMs: 5_000, hedgeMs: 5_000 },
  );

  const result = await router.route(["wayback"], {
    call: (_id, _key, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    accept: (value) => value.length > 0,
    empty: "empty",
  });

  expect(result.success).toBe(false);
  expect(!result.success && result.error).toContain("no answer within 0.06s");
  expect(store.load().benched["fetch/wayback"]).toBeGreaterThan(0);
});

test("a short page is read instead of being mistaken for a JavaScript shell", async () => {
  const short = "<html><head><title>Example Domain</title></head><body><p>This domain is for use in documentation examples without needing permission. Avoid use in operations.</p></body></html>";
  const page = await pageFromHtml(short, "https://example.com", "markdown");

  expect(page.title).toBe("Example Domain");
  expect(page.content).toContain("documentation examples");
});

test("a page that really does need JavaScript is still rejected", async () => {
  const shell =
    "<html><head><title>App</title></head><body><div id=\"root\"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>";

  await expect(pageFromHtml(shell, "https://app.example.com", "markdown")).rejects.toThrow(/JavaScript/);
});
