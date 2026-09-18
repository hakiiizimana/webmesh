#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSearch, fileStore, isProviderId, providers, type SearchResult } from "@webmesh/core";
import { z } from "zod";

const searcher = createSearch(providers, { store: fileStore() });

async function runSearch(query: string, limit?: string, only?: string): Promise<SearchResult> {
  if (!query) return { success: false, error: "Missing query." };
  const requested = only?.split(",").map((id) => id.trim());
  const unknown = requested?.filter((id) => !isProviderId(id));
  if (unknown?.length) return { success: false, error: `Unknown provider(s): ${unknown.join(", ")}.` };
  return searcher.search(query, {
    limit: limit ? Number(limit) : undefined,
    only: requested?.filter(isProviderId),
  });
}

async function serveMcp() {
  const server = new McpServer({ name: "webmesh", version: "0.1.0" });
  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Search the web. Returns JSON: { success, data: [{ title, url, description }] }. " +
        "Rotates across free search providers and falls back automatically when one fails.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for."),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 10)."),
      },
    },
    async ({ query, limit }) => {
      const result = await searcher.search(query, { limit });
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.success };
    },
  );
  await server.connect(new StdioServerTransport());
}

const USAGE = `webmesh search <query>     search the web (JSON)
  -n, --limit <n>            max results (default 10)
  -p, --providers <a,b>      only use these providers
webmesh providers            list providers (JSON)
webmesh mcp                  run the MCP server over stdio`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string", short: "n" },
    providers: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...rest] = positionals;
const print = <T,>(value: T) => console.log(JSON.stringify(value, null, 2));

if (command === "search" && !values.help) {
  const result = await runSearch(rest.join(" "), values.limit, values.providers);
  print(result);
  if (!result.success) process.exitCode = 1;
} else if (command === "providers") {
  print({ success: true, data: searcher.status() });
} else if (command === "mcp") {
  await serveMcp();
} else {
  console.log(USAGE);
}
