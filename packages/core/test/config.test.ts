import { expect, test } from "bun:test";
import { providers } from "../src/config";
import type { SearchFilters } from "../src/types";

test("builds keyless Tavily requests", () => {
  expect(providers["tavily-keyless"].headers?.())
    .toEqual({ "x-tavily-access-mode": "keyless" });
});

test("builds Tavily filters", () => {
  const body = providers.tavily.body("rust ownership", 8, {
    freshness: { from: "2026-01-01", to: "2026-01-31" },
    includeDomains: ["rust-lang.org"],
    excludeDomains: ["reddit.com"],
    type: "news",
    country: "SI",
    language: "en",
    safeSearch: "strict",
    exactMatch: true,
    searchDepth: "deep",
  });

  expect(body).toMatchObject({
    query: "rust ownership",
    max_results: 8,
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    include_domains: ["rust-lang.org"],
    exclude_domains: ["reddit.com"],
    topic: "news",
    country: "Slovenia",
    language: "en",
    safe_search: true,
    exact_match: true,
    search_depth: "advanced",
  });
});

test("builds SearchX filters", () => {
  const url = new URL(
    providers.searchx.url("rust ownership", 80, {
      freshness: { from: "2026-01-01", to: "2026-01-31" },
      includeDomains: ["rust-lang.org"],
      excludeDomains: ["reddit.com"],
      type: "news",
      country: "SI",
      language: "sl",
      safeSearch: "strict",
      exactMatch: true,
    }),
  );

  expect(url.pathname).toBe("/api/v1/search");
  expect(url.searchParams.get("per_page")).toBe("50");
  expect(url.searchParams.get("mode")).toBe("hybrid");
  expect(url.searchParams.get("freshness")).toBe("2026-01-01..2026-01-31");
  expect(url.searchParams.get("country")).toBe("SI");
  expect(url.searchParams.get("lang")).toBe("sl");
  expect(url.searchParams.get("safe_search")).toBe("true");
  expect(url.searchParams.get("category")).toBe("news");
  expect(url.searchParams.get("q")).toContain('"rust ownership"');
  expect(url.searchParams.get("q")).toContain("site:rust-lang.org");
  expect(url.searchParams.get("q")).toContain("-site:reddit.com");
});

test("builds HN Algolia filters", () => {
  const url = new URL(
    providers["hn-algolia"].url("rust ownership", 80, {
      freshness: { from: "2026-01-01", to: "2026-01-31" },
      exactMatch: true,
    }),
  );

  expect(url.searchParams.get("tags")).toBe("story");
  expect(url.searchParams.get("hitsPerPage")).toBe("50");
  expect(url.searchParams.get("query")).toBe('"rust ownership"');
  expect(url.searchParams.get("numericFilters")).toBe("created_at_i>1767225600,created_at_i<1769903999");
});

test("builds Stack Exchange filters", () => {
  const url = new URL(
    providers.stackexchange.url("rust ownership", 200, {
      freshness: { from: "2026-01-01", to: "2026-01-31" },
    }),
  );

  expect(url.searchParams.get("site")).toBe("stackoverflow");
  expect(url.searchParams.get("q")).toBe("rust ownership");
  expect(url.searchParams.get("pagesize")).toBe("100");
  expect(url.searchParams.get("filter")).toBe("withbody");
  expect(url.searchParams.get("fromdate")).toBe("1767225600");
  expect(url.searchParams.get("todate")).toBe("1769903999");
});

test("builds OpenAlex filters", () => {
  const url = new URL(
    providers.openalex.url("rust ownership", 200, {
      freshness: { from: "2026-01-01" },
      language: "en",
      exactMatch: true,
    }),
  );

  expect(url.searchParams.get("search")).toBe('"rust ownership"');
  expect(url.searchParams.get("per_page")).toBe("100");
  expect(url.searchParams.get("select")).toContain("abstract_inverted_index");
  expect(url.searchParams.get("filter")).toBe("from_publication_date:2026-01-01,language:en");
});

// Verticals answer any query, so they stay out of the default pool and decline filters they cannot pass through.
test("keeps vertical search providers opt-in and honest about filters", () => {
  for (const id of ["hn-algolia", "stackexchange", "openalex"] as const) {
    expect(providers[id].manual).toBe(true);
    expect(providers[id].supports?.({ type: "news" })).toBe(false);
    expect(providers[id].supports?.({ type: "video" })).toBe(false);
    expect(providers[id].supports?.({ includeDomains: ["rust-lang.org"] })).toBe(false);
    expect(providers[id].supports?.({ type: "web" })).toBe(true);
  }
  expect(providers.openalex.supports?.({ language: "en" })).toBe(true);
  expect(providers.stackexchange.supports?.({ language: "en" })).toBe(false);
  expect(providers["hn-algolia"].supports?.({ freshness: "week" })).toBe(true);
});

test("builds Brave news filters", () => {
  const url = new URL(
    providers.brave.url("rust ownership", 8, {
      freshness: "week",
      includeDomains: ["rust-lang.org"],
      excludeDomains: ["reddit.com"],
      type: "news",
      country: "SI",
      language: "sl",
      safeSearch: "strict",
      exactMatch: true,
    }),
  );

  expect(url.pathname).toBe("/res/v1/news/search");
  expect(url.searchParams.get("freshness")).toBe("pw");
  expect(url.searchParams.get("country")).toBe("SI");
  expect(url.searchParams.get("search_lang")).toBe("sl");
  expect(url.searchParams.get("safesearch")).toBe("strict");
  expect(url.searchParams.get("q")).toContain('"rust ownership"');
  expect(url.searchParams.get("q")).toContain("site:rust-lang.org");
  expect(url.searchParams.get("q")).toContain("-site:reddit.com");
});

test("builds Firecrawl web filters", () => {
  const body = providers.firecrawl.body("web scraping", 5, {
    freshness: "day",
    includeDomains: ["firecrawl.dev"],
    type: "web",
    country: "DE",
    safeSearch: "moderate",
    exactMatch: true,
  });

  expect(body).toMatchObject({
    query: '"web scraping"',
    limit: 5,
    sources: ["web"],
    includeDomains: ["firecrawl.dev"],
    location: "Germany",
    safe: true,
    tbs: "qdr:d",
  });
});

test("builds Parallel deep search filters", () => {
  const body = providers.parallel.body("latest Rust release", 5, {
    freshness: "month",
    includeDomains: ["rust-lang.org"],
    searchDepth: "deep",
  });

  expect(body).toMatchObject({
    objective: "latest Rust release",
    search_queries: ["latest Rust release"],
    mode: "advanced",
    advanced_settings: {
      source_policy: {
        include_domains: ["rust-lang.org"],
      },
    },
  });
});

test("routes YouTube only for supported video filters", () => {
  expect(providers.youtube.kind).toBe("scrape");
  expect(providers.youtube.supports?.({ type: "news" })).toBe(false);
  expect(providers.youtube.supports?.({ type: "web" })).toBe(false);
  expect(providers.youtube.supports?.({ type: "video" })).toBe(true);
  expect(
    providers.youtube.supports?.({
      type: "video",
      freshness: { from: "2026-01-01", to: "2026-01-31" },
    }),
  ).toBe(false);
  expect(providers.tavily.supports?.({ type: "video" })).toBe(false);
  expect(providers.brave.supports?.({ type: "video" })).toBe(false);
});

test("builds DuckDuckGo and Brave web filter URLs", () => {
  const filters: SearchFilters = {
    freshness: "week",
    includeDomains: ["sqlite.org"],
    excludeDomains: ["stackoverflow.com"],
    exactMatch: true,
    safeSearch: "strict",
  };
  const ddg = new URL(providers["duckduckgo-html"].url("wal mode", filters)).searchParams;
  const brave = new URL(providers["brave-web"].url("wal mode", { ...filters, safeSearch: undefined })).searchParams;

  expect(Object.fromEntries(ddg)).toEqual({
    q: '"wal mode" (site:sqlite.org) -site:stackoverflow.com',
    df: "w",
    kp: "1",
  });
  expect(Object.fromEntries(brave)).toEqual({
    q: '"wal mode" (site:sqlite.org) -site:stackoverflow.com',
    source: "web",
    tf: "pw",
  });
});

test("scrapers decline filters they cannot pass through", () => {
  const range = { freshness: { from: "2026-01-01", to: "2026-01-31" } };
  expect(providers["duckduckgo-lite"].supports({ freshness: "day", safeSearch: "off" })).toBe(true);
  expect(providers["duckduckgo-lite"].supports(range)).toBe(false);
  expect(providers["duckduckgo-html"].supports({ country: "SI" })).toBe(false);
  expect(providers["brave-web"].supports({ safeSearch: "strict" })).toBe(false);
  expect(providers["brave-web"].supports(range)).toBe(false);
});
