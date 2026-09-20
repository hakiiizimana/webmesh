#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  agentBrowserPath,
  browserEnv,
  browserReference,
  browserUsage,
  checkProviders,
  createBrowser,
  ensureBrowser,
  LOGIN_STATE,
  createFetch,
  createSearch,
  fetchers,
  isFetcherId,
  isProviderId,
  launchFlags,
  loadSettings,
  maskProxy,
  mergeEnv,
  openStore,
  prepareBrowserCommand,
  providers,
  usesProxy,
  type FetchResult,
  type Freshness,
  type SearchFilters,
  type SearchResult,
} from "@webmesh/core";
import { z } from "zod";
import { version } from "../package.json";
import { setKey, setProxy, setup, type SetupResult } from "./setup";

const settings = (() => {
  try {
    return loadSettings();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})();
const env = mergeEnv(settings.keys, process.env);
const store = openStore();
const searcher = createSearch(providers, { store, cache: store, env, proxy: settings.proxy });
const fetcher = createFetch(fetchers, {
  store,
  env,
  proxy: settings.proxy,
  allowPrivateNetworks: settings.allowPrivateNetworks,
});

const limitSchema = z.number().int().min(1).max(20);
const pageUrl = z.url({ protocol: /^https?$/ });
const fetchFormatSchema = z.enum(["markdown", "html", "rawHtml", "links", "json"]);
const fetchFormatsSchema = z.array(fetchFormatSchema).min(1).max(5);
const extractionSchema = z.record(z.string(), z.json());
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
  { formats, schemaFile, maxCharacters, only }: { formats?: string; schemaFile?: string; maxCharacters?: string; only?: string } = {},
): Promise<FetchResult> {
  const parsedUrl = pageUrl.safeParse(url);
  if (!parsedUrl.success) return { success: false, error: "Pass an http or https URL." };
  const parsedFormats = formats === undefined ? undefined : fetchFormatsSchema.safeParse(list(formats));
  if (parsedFormats && !parsedFormats.success) return { success: false, error: "Formats must be markdown, html, rawHtml, links, or json." };
  let schema: z.infer<typeof extractionSchema> | undefined;
  if (schemaFile) {
    try {
      const parsed = extractionSchema.safeParse(JSON.parse(readFileSync(schemaFile, "utf8")));
      if (!parsed.success) return { success: false, error: "Schema file must contain a JSON object." };
      schema = parsed.data;
    } catch {
      return { success: false, error: `Could not read schema file: ${schemaFile}.` };
    }
  }
  const parsedMax = maxCharacters === undefined ? undefined : maxCharactersSchema.safeParse(Number(maxCharacters));
  if (parsedMax && !parsedMax.success) return { success: false, error: "Max characters must be a whole number from 1000 to 1000000." };
  const requested = only?.split(",").map((id) => id.trim());
  const unknown = requested?.filter((id) => !isFetcherId(id));
  if (unknown?.length) return { success: false, error: `Unknown fetcher(s): ${unknown.join(", ")}.` };
  return fetcher.fetch(parsedUrl.data, {
    formats: parsedFormats?.data,
    schema,
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
        "Fetch a web page and return one or more representations: markdown, cleaned HTML, raw HTML, links, or schema-shaped JSON. " +
        "Returns JSON: { success, data: { url, title, format, content, metadata, rawHtml?, links?, json?, truncated } }. " +
        "Tries a local fetch first, then remote readers, and uses keyed readers only when free ones can't answer.",
      inputSchema: {
        url: pageUrl.describe("The http or https page to fetch."),
        format: fetchFormatSchema.optional().describe("One format; markdown is the default."),
        formats: fetchFormatsSchema.optional().describe("One or more output formats."),
        schema: extractionSchema.optional().describe("JSON Schema-like object used when formats includes json."),
        maxCharacters: maxCharactersSchema.optional().describe("Cut the content at this many characters (default 50000)."),
        providers: z.array(z.string()).optional().describe("Only use these fetcher IDs."),
      },
    },
    async ({ url, format, formats, schema, maxCharacters, providers: requested }) => {
      if (format && formats) {
        const result: FetchResult = { success: false, error: "Pass format or formats, not both." };
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
      }
      const unknown = requested?.filter((id) => !isFetcherId(id));
      if (unknown?.length) {
        const result: FetchResult = { success: false, error: `Unknown fetcher(s): ${unknown.join(", ")}.` };
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
      }
      const result = await fetcher.fetch(url, {
        formats: formats ?? (format ? [format] : undefined),
        schema,
        maxCharacters,
        only: requested?.filter(isFetcherId),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.success };
    },
  );
  const browser = createBrowser(`webmesh-mcp-${process.pid}`, {
    restore: LOGIN_STATE,
    redact: process.env.WEBMESH_REVEAL_SECRETS !== "1",
    proxy: settings.proxy,
    allowPrivateNetworks: settings.allowPrivateNetworks,
  });
  if (agentBrowserPath()) {
    server.registerTool(
      "browser",
      {
        title: "Browser",
        description:
          "Drive a real Chrome browser: open pages, click, type, read, and take screenshots. Pass one browser command as args. " +
          'Loop: ["open", url], then ["snapshot", "-i"] to list interactive elements as @e1, @e2, then ["click", "@e2"], ' +
          '["fill", "@e3", "text"], or ["press", "Enter"]. Run ["snapshot", "-i"] again after the page changes; refs go stale. ' +
          '["screenshot", "--annotate"] labels elements with their refs; add "--if-changed" to skip unchanged images. ' +
          '["read"] returns the rendered page as text. Also ["get", "text", "@e1"], ["select", "@e4", "value"], ["upload", "@e5", "/path"], ' +
          '["scroll", "down"], ["tab", "list"], ["back"]. Run `webmesh browser --help` for the command list. ' +
          "Use absolute paths for pdf, upload, and --screenshot-dir; relative paths resolve from the browser's background process. " +
          "Sessions start with the logins saved by `webmesh login`. Secrets in output are redacted. " +
          "The session belongs to this server and closes when it exits. Returns JSON: { success, data } or { success, error }.",
        inputSchema: {
          args: z.array(z.string()).min(1).describe('One browser command, e.g. ["click", "@e2"].'),
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
webmesh fetch <url>        fetch one or more page representations (JSON)
      --format <markdown|html|rawHtml|links|json>
                              comma-separate formats, default: markdown
      --schema-file <path>  JSON schema for the json format
      --max-characters <n>   cut content at n characters (default 50000)
  -p, --providers <a,b>      only use these fetchers
webmesh browser <command>    drive Chrome, e.g. open <url>, snapshot -i, click @e2
webmesh setup                add webmesh to every coding agent found on this machine
  -a, --agent <name>         only this agent (claude-code, codex, cursor, pi, opencode)
      --remove               take webmesh out again
webmesh setup proxy <url>    send scrapers, local fetches, and anonymous browsing through a proxy (--remove to stop)
webmesh setup key <NAME>     save an API key such as EXA_API_KEY; reads it from stdin (--remove to delete)
webmesh login <url>          log in once in a visible browser; later browser sessions start logged in
webmesh logout               forget saved logins
webmesh check                try every provider once; exits 1 if one looks broken (not just blocked)
webmesh providers            list search and fetch providers with cooldowns and health (JSON)
webmesh mcp                  run the MCP server over stdio`;

if (process.argv[2] === "browser") {
  const args = process.argv.slice(3);
  if (args.length === 1 && args[0] === "--all") {
    console.log(browserReference());
    process.exit(0);
  }
  if (args.length === 0 || args[0] === "help" || args[0] === "--full-help" || args.includes("--help") || args.includes("-h")) {
    console.log(browserUsage());
    process.exit(0);
  }
  const prepared = prepareBrowserCommand(args);
  if ("error" in prepared) {
    console.error(prepared.error);
    process.exit(1);
  }
  const bin = agentBrowserPath();
  if (!bin) {
    console.error("Webmesh browser support is not installed.");
    process.exit(1);
  }
  if (prepared.args[0] !== "close") {
    const installError = await ensureBrowser(bin);
    if (installError) {
      console.error(installError);
      process.exit(1);
    }
  }
  const launch = await launchFlags(bin, { restore: LOGIN_STATE, proxy: settings.proxy });
  const proc = Bun.spawn([process.execPath, bin, "--session", "webmesh", ...launch, ...prepared.args], {
    env: browserEnv(settings.proxy),
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}

if (process.argv[2] === "login" || process.argv[2] === "logout") {
  const bin = agentBrowserPath();
  if (!bin) {
    console.error("Webmesh browser support is not installed.");
    process.exit(1);
  }
  const run = (args: string[]) =>
    Bun.spawn([process.execPath, bin, ...args], { env: browserEnv(settings.proxy), stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (process.argv[2] === "logout") process.exit(await run(["state", "clear", LOGIN_STATE]));
  const installError = await ensureBrowser(bin);
  if (installError) {
    console.error(installError);
    process.exit(1);
  }
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
    "schema-file": { type: "string" },
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
    formats: values.format,
    schemaFile: values["schema-file"],
    maxCharacters: values["max-characters"],
    only: values.providers,
  });
  print(result);
  if (!result.success) process.exitCode = 1;
} else if (command === "setup" && !values.help) {
  const [target, ...params] = rest;
  const remove = values.remove === true;
  let outcome: SetupResult;
  if (target === "proxy") outcome = setProxy(params[0], remove);
  else if (target === "key") outcome = await setKey(params[0], params[1], remove);
  else outcome = { ok: true, lines: await setup(values.agent, remove) };
  console.log(outcome.lines.join("\n"));
  if (!outcome.ok) process.exitCode = 1;
} else if (command === "check" && !values.help) {
  const results = await checkProviders(env, settings.proxy);
  const broken = results.filter((result) => result.status === "broken");
  print({ success: broken.length === 0, data: results });
  if (broken.length > 0) process.exitCode = 1;
} else if (command === "providers") {
  const viaProxy = <T extends { kind: Parameters<typeof usesProxy>[0] }>(rows: T[]) =>
    rows.map((row) => ({ ...row, proxy: Boolean(settings.proxy) && usesProxy(row.kind) }));
  print({
    success: true,
    data: {
      proxy: settings.proxy ? maskProxy(settings.proxy) : null,
      search: viaProxy(searcher.status()),
      fetch: viaProxy(fetcher.status()),
    },
  });
} else if (command === "mcp") {
  await serveMcp();
} else {
  console.log(USAGE);
}
