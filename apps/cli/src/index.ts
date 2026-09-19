#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createSearch,
  fileStore,
  isProviderId,
  providers,
  type Freshness,
  type SearchFilters,
  type SearchResult,
} from "@webmesh/core";
import { z } from "zod";

const searcher = createSearch(providers, { store: fileStore() });

const limitSchema = z.number().int().min(1).max(20);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");
const filtersSchema = z.object({
  freshness: z.union([z.enum(["day", "week", "month", "year"]), z.object({ from: date, to: date.optional() })]).optional(),
  includeDomains: z.array(z.string().min(1)).optional(),
  excludeDomains: z.array(z.string().min(1)).optional(),
  type: z.enum(["web", "news", "video"]).optional(),
  country: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  safeSearch: z.enum(["strict", "moderate", "off"]).optional(),
  exactMatch: z.boolean().optional(),
  searchDepth: z.enum(["fast", "deep"]).optional(),
});

function list(value: string | undefined): string[] | undefined {
  const values = value?.split(",").map((part) => part.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}

function parseFreshness(value: string | undefined): Freshness | undefined {
  if (!value) return undefined;
  if (value === "day") return "day";
  if (value === "week") return "week";
  if (value === "month") return "month";
  if (value === "year") return "year";
  const parts = value.split("..");
  if (parts.length > 2 || !parts[0]) throw new Error("Freshness must be day, week, month, year, or FROM..TO.");
  return parts[1] ? { from: parts[0], to: parts[1] } : { from: parts[0] };
}

type CliFilterValues = {
  freshness?: string;
  includeDomains?: string;
  excludeDomains?: string;
  type?: string;
  country?: string;
  language?: string;
  safeSearch?: string;
  exactMatch?: boolean;
  searchDepth?: string;
};

type ParsedCliFilters = { ok: true; filters: SearchFilters } | { ok: false; error: string };

function parseCliFilters(values: CliFilterValues): ParsedCliFilters {
  try {
    const parsed = filtersSchema.safeParse({
      freshness: parseFreshness(values.freshness),
      includeDomains: list(values.includeDomains),
      excludeDomains: list(values.excludeDomains),
      type: values.type,
      country: values.country,
      language: values.language,
      safeSearch: values.safeSearch,
      exactMatch: values.exactMatch === true ? true : undefined,
      searchDepth: values.searchDepth,
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid search filters." };
    return { ok: true, filters: parsed.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runSearch(
  query: string,
  { limit, only, filters }: { limit?: string; only?: string; filters?: SearchFilters } = {},
): Promise<SearchResult> {
  if (!query) return { success: false, error: "Missing query." };
  const parsedLimit = limit === undefined ? undefined : limitSchema.safeParse(Number(limit));
  if (parsedLimit && !parsedLimit.success) return { success: false, error: "Limit must be a whole number from 1 to 20." };
  const requested = only?.split(",").map((id) => id.trim());
  const unknown = requested?.filter((id) => !isProviderId(id));
  if (unknown?.length) return { success: false, error: `Unknown provider(s): ${unknown.join(", ")}.` };
  return searcher.search(query, {
    limit: parsedLimit?.data,
    only: requested?.filter(isProviderId),
    filters,
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
        "Routes to the most reliable free search providers, falls back when one fails or is slow, " +
        "and uses keyed providers only when free ones can't answer.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for."),
        limit: limitSchema.optional().describe("Max results (default 10)."),
        providers: z.array(z.string()).optional().describe("Only use these provider IDs."),
        filters: filtersSchema.optional().describe("Provider-neutral search filters."),
      },
    },
    async ({ query, limit, providers: requested, filters }) => {
      const unknown = requested?.filter((id) => !isProviderId(id));
      if (unknown?.length) {
        const result: SearchResult = { success: false, error: `Unknown provider(s): ${unknown.join(", ")}.` };
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
      }
      const result = await searcher.search(query, { limit, only: requested?.filter(isProviderId), filters });
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.success };
    },
  );
  await server.connect(new StdioServerTransport());
}

const USAGE = `webmesh search <query>     search the web (JSON)
  -n, --limit <n>            max results (default 10)
  -p, --providers <a,b>      only use these providers
      --freshness <value>    day, week, month, year, or FROM..TO
      --include-domains <a,b>
      --exclude-domains <a,b>
      --type <web|news|video>
      --country <code|name>
      --language <code>
      --safe-search <strict|moderate|off>
      --exact-match
      --search-depth <fast|deep>
webmesh providers            list providers (JSON)
webmesh mcp                  run the MCP server over stdio`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string", short: "n" },
    providers: { type: "string", short: "p" },
    freshness: { type: "string" },
    "include-domains": { type: "string" },
    "exclude-domains": { type: "string" },
    type: { type: "string" },
    country: { type: "string" },
    language: { type: "string" },
    "safe-search": { type: "string" },
    "exact-match": { type: "boolean" },
    "search-depth": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...rest] = positionals;
const print = <T,>(value: T) => console.log(JSON.stringify(value, null, 2));

if (command === "search" && !values.help) {
  const parsedFilters = parseCliFilters({
    freshness: values.freshness,
    includeDomains: values["include-domains"],
    excludeDomains: values["exclude-domains"],
    type: values.type,
    country: values.country,
    language: values.language,
    safeSearch: values["safe-search"],
    exactMatch: values["exact-match"],
    searchDepth: values["search-depth"],
  });
  const result = parsedFilters.ok
    ? await runSearch(rest.join(" "), {
        limit: values.limit,
        only: values.providers,
        filters: parsedFilters.filters,
      })
    : { success: false, error: parsedFilters.error };
  print(result);
  if (!result.success) process.exitCode = 1;
} else if (command === "providers") {
  print({ success: true, data: searcher.status() });
} else if (command === "mcp") {
  await serveMcp();
} else {
  console.log(USAGE);
}
