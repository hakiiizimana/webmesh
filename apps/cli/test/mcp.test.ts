import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFetch, createSearch, type Fetcher, memoryStore, type Provider, type SearchItem } from "@webmesh/core";
import { createMcpServer, MAX_BATCH } from "../src/mcp";

const item: SearchItem = { title: "WAL", url: "https://sqlite.org/wal.html", description: "Write-ahead log" };

// Real routers over stub providers: the MCP layer is under test, not the network.
async function connect(searchCalls: string[] = []) {
  const searchStub: Provider = {
    kind: "public",
    search: async (query) => {
      searchCalls.push(query);
      return [item];
    },
  };
  const readerStub: Fetcher = {
    kind: "public",
    formats: ["markdown"],
    fetch: async (url) => ({ url, title: "WAL", content: "Write-ahead logging keeps readers going." }),
  };
  // String-keyed registries, so the stub routers accept any provider ID the server passes.
  const searchers = Object.fromEntries([["duckduckgo-lite", searchStub]]);
  const readers = Object.fromEntries([["direct", readerStub]]);
  const store = memoryStore();
  const searcher = createSearch(searchers, { store, env: {} });
  const fetcher = createFetch(readers, { store, env: {}, resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  const server = createMcpServer({ version: "test", searcher, fetcher });
  const client = new Client({ name: "test", version: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

test("advertises the real provider and fetcher IDs, and an output schema", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const search = tools.find((tool) => tool.name === "web_search");
  const fetch = tools.find((tool) => tool.name === "web_fetch");

  expect(JSON.stringify(search?.inputSchema)).toContain('"duckduckgo-lite"');
  expect(JSON.stringify(fetch?.inputSchema)).toContain('"jina-reader"');
  expect(search?.outputSchema).toBeDefined();
  expect(fetch?.outputSchema).toBeDefined();
});

test("returns the search as structured content matching its description", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "web_search", arguments: { query: "sqlite wal" } });

  expect(result.isError).toBe(false);
  expect(result.structuredContent).toEqual({ success: true, data: [item] });
});

test("rejects unknown provider IDs and oversized batches before any search runs", async () => {
  const calls: string[] = [];
  const client = await connect(calls);
  const unknown = await client.callTool({ name: "web_search", arguments: { query: "x", providers: ["nope"] } });
  const tooMany = await client.callTool({
    name: "web_search",
    arguments: { queries: Array.from({ length: MAX_BATCH + 1 }, (_, index) => `q${index}`) },
  });

  expect(unknown.isError).toBe(true);
  expect(tooMany.isError).toBe(true);
  expect(calls).toEqual([]);
});

test("fetch returns the page as structured content", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://sqlite.org/wal.html" } });

  expect(result.isError).toBe(false);
  expect(result.structuredContent).toMatchObject({ success: true, data: { title: "WAL", format: "markdown" } });
});
