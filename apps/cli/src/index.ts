#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  agentBrowserPath,
  createBrowser,
  LOGIN_STATE,
  createFetch,
  createSearch,
  fetchers,
  isFetcherId,
  isProviderId,
  openStore,
  providers,
  type FetchResult,
  type Freshness,
  type SearchFilters,
  type SearchResult,
} from "@webmesh/core";
import { z } from "zod";
import { version } from "../package.json";
import { setup } from "./setup";

const store = openStore();
const searcher = createSearch(providers, { store, cache: store });
const fetcher = createFetch(fetchers, { store });

const limitSchema = z.number().int().min(1).max(20);
const pageUrl = z.url({ protocol: /^https?$/ });
const formatSchema = z.enum(["markdown", "html"]);
const maxCharactersSchema = z.number().int().min(1_000).max(1_000_000);
const screenshot = z.object({ path: z.string().regex(/\.(png|jpe?g|webp)$/i) });
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as const;
const isImageType = (ext: string): ext is keyof typeof IMAGE_TYPES => Object.hasOwn(IMAGE_TYPES, ext);
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

async function runFetch(
  url: string | undefined,
  { format, maxCharacters, only }: { format?: string; maxCharacters?: string; only?: string } = {},
): Promise<FetchResult> {
  const parsedUrl = pageUrl.safeParse(url);
  if (!parsedUrl.success) return { success: false, error: "Pass an http or https URL." };
  const parsedFormat = formatSchema.optional().safeParse(format);
  if (!parsedFormat.success) return { success: false, error: "Format must be markdown or html." };
  const parsedMax = maxCharacters === undefined ? undefined : maxCharactersSchema.safeParse(Number(maxCharacters));
  if (parsedMax && !parsedMax.success) return { success: false, error: "Max characters must be a whole number from 1000 to 1000000." };
  const requested = only?.split(",").map((id) => id.trim());
  const unknown = requested?.filter((id) => !isFetcherId(id));
  if (unknown?.length) return { success: false, error: `Unknown fetcher(s): ${unknown.join(", ")}.` };
  return fetcher.fetch(parsedUrl.data, {
    format: parsedFormat.data,
    maxCharacters: parsedMax?.data,
    only: requested?.filter(isFetcherId),
  });
}

async function serveMcp() {
  const server = new McpServer({ name: "webmesh", version });
  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Search the web. Returns JSON: { success, provider, attempts, data: [{ title, url, description, publishedAt? }] }. " +
        "publishedAt is YYYY-MM-DD when the provider reports it. " +
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
  server.registerTool(
    "web_fetch",
    {
      title: "Fetch a page",
      description:
        "Fetch a web page and return its main content as markdown (default) or HTML. " +
        "Returns JSON: { success, provider, attempts, data: { url, title, format, content, truncated, publishedAt? } }. " +
        "Tries a local fetch first, then remote readers, and uses keyed readers only when free ones can't answer.",
      inputSchema: {
        url: pageUrl.describe("The http or https page to fetch."),
        format: formatSchema.optional().describe("markdown (default) or html."),
        maxCharacters: maxCharactersSchema.optional().describe("Cut the content at this many characters (default 50000)."),
        providers: z.array(z.string()).optional().describe("Only use these fetcher IDs."),
      },
    },
    async ({ url, format, maxCharacters, providers: requested }) => {
      const unknown = requested?.filter((id) => !isFetcherId(id));
      if (unknown?.length) {
        const result: FetchResult = { success: false, error: `Unknown fetcher(s): ${unknown.join(", ")}.` };
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
      }
      const result = await fetcher.fetch(url, { format, maxCharacters, only: requested?.filter(isFetcherId) });
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.success };
    },
  );
  const browser = createBrowser(`webmesh-mcp-${process.pid}`, {
    restore: LOGIN_STATE,
    redact: process.env.WEBMESH_REVEAL_SECRETS !== "1",
  });
  if (agentBrowserPath()) {
    server.registerTool(
      "browser",
      {
        title: "Browser",
        description:
          "Drive a real Chrome browser: open pages, click, type, read, and take screenshots. Pass one agent-browser command as args. " +
          'Loop: ["open", url], then ["snapshot", "-i"] to list interactive elements as @e1, @e2, then ["click", "@e2"], ' +
          '["fill", "@e3", "text"], or ["press", "Enter"]. Run ["snapshot", "-i"] again after the page changes; refs go stale. ' +
          '["screenshot", "--annotate"] labels elements with their refs; add "--if-changed" to skip unchanged images. ' +
          '["read"] returns the rendered page as text. Also ["get", "text", "@e1"], ["select", "@e4", "value"], ["upload", "@e5", "/path"], ' +
          '["scroll", "down"], ["tab", "list"], ["back"]. ["skills", "get", "core"] returns the full guide. ' +
          "Sessions start with the logins saved by `webmesh login`. Secrets in output are redacted. " +
          "The session belongs to this server and closes when it exits. Returns JSON: { success, data } or { success, error }.",
        inputSchema: {
          args: z.array(z.string()).min(1).describe('One agent-browser command, e.g. ["click", "@e2"].'),
        },
      },
      async ({ args }) => {
        const result = await browser.run(args);
        const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(result) }];
        const shot = screenshot.safeParse(result.success ? result.data : null);
        const ext = shot.success ? (shot.data.path.split(".").pop() ?? "").toLowerCase() : "";
        if (shot.success && isImageType(ext)) {
          const data = Buffer.from(await Bun.file(shot.data.path).arrayBuffer()).toString("base64");
          content.push({ type: "image", data, mimeType: IMAGE_TYPES[ext] });
        }
        return { content, isError: !result.success };
      },
    );
  }
  const shutdown = async () => {
    await browser.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
webmesh fetch <url>        fetch a page as markdown or HTML (JSON)
      --format <markdown|html>
      --max-characters <n>   cut content at n characters (default 50000)
  -p, --providers <a,b>      only use these fetchers
webmesh browser <command>    drive Chrome with agent-browser, e.g. open <url>, snapshot -i, click @e2
webmesh setup                add webmesh to every coding agent found on this machine
  -a, --agent <name>         only this agent (claude-code, codex, cursor, pi, opencode)
      --remove               take webmesh out again
webmesh login <url>          log in once in a visible browser; later browser sessions start logged in
webmesh logout               forget saved logins
webmesh providers            list search and fetch providers with cooldowns and health (JSON)
webmesh mcp                  run the MCP server over stdio`;

if (process.argv[2] === "browser") {
  const bin = agentBrowserPath();
  if (!bin) {
    console.error("agent-browser is not installed.");
    process.exit(1);
  }
  const args = process.argv.slice(3);
  const flag = (names: string[]) => args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
  const session = flag(["--session"]) ? [] : ["--session", "webmesh"];
  const login = flag(["--restore", "--profile", "--state", "--auto-connect"])
    ? []
    : ["--restore", LOGIN_STATE, "--restore-save", "never"];
  const proc = Bun.spawn([process.execPath, bin, ...session, ...login, ...args], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}

if (process.argv[2] === "login" || process.argv[2] === "logout") {
  const bin = agentBrowserPath();
  if (!bin) {
    console.error("agent-browser is not installed.");
    process.exit(1);
  }
  const run = (args: string[]) => Bun.spawn([process.execPath, bin, ...args], { stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (process.argv[2] === "logout") process.exit(await run(["state", "clear", LOGIN_STATE]));
  const url = pageUrl.safeParse(process.argv[3]);
  if (!url.success) {
    console.error("Usage: webmesh login <url>");
    process.exit(1);
  }
  const base = ["--session", "webmesh-login", "--restore", LOGIN_STATE, "--restore-save", "always", "--headed"];
  if ((await run([...base, "open", url.data])) !== 0) process.exit(1);
  console.log("Log in in the browser window, then press Enter here to save.");
  for await (const _line of console) break;
  await run([...base, "close"]);
  console.log("Saved. Browser sessions from webmesh now start logged in. Run webmesh login again when a login expires.");
  process.exit(0);
}

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
    format: { type: "string" },
    "max-characters": { type: "string" },
    agent: { type: "string", short: "a" },
    remove: { type: "boolean" },
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
} else if (command === "fetch" && !values.help) {
  const result = await runFetch(rest[0], {
    format: values.format,
    maxCharacters: values["max-characters"],
    only: values.providers,
  });
  print(result);
  if (!result.success) process.exitCode = 1;
} else if (command === "setup" && !values.help) {
  console.log((await setup(values.agent, values.remove === true)).join("\n"));
} else if (command === "providers") {
  print({ success: true, data: { search: searcher.status(), fetch: fetcher.status() } });
} else if (command === "mcp") {
  await serveMcp();
} else {
  console.log(USAGE);
}
