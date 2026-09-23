#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adaptBrowserSkill,
  agentBrowserPath,
  browserCommandName,
  browserEnv,
  browserProvider,
  browserReference,
  browserUsage,
  BROWSER_TIMEOUT_MS,
  cleanEngineOutput,
  engineArgs,
  ensureBrowser,
  ensureBrowserFilter,
  FILTER_ENV,
  filteredEnv,
  killTree,
  launchFlags,
  loginBypass,
  loginHosts,
  LOGIN_STATE,
  prepareBrowserCommand,
  redact,
  serveBrowserFilter,
  stopBrowserFilter,
  type Launch,
} from "@webmesh/core/browser";
import { loadSettings, maskProxy, mergeEnv } from "@webmesh/core/settings";
import { blockedUrl, searchFilters, type FetchFormat, type FetchResult, type FetchedOne, type FetcherId, type Freshness, type ProviderId, type SearchFilters, type SearchResult, type SearchedOne } from "@webmesh/core";
import { z } from "zod";
import { version } from "../package.json";
import { extractionSchema, fetchFormatsSchema, limitSchema, maxCharactersSchema, pageUrl } from "./mcp";
import type { SetupResult } from "./setup";

const settings = (() => {
  try {
    return loadSettings();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})();

async function engines() {
  const { createFetch, createSearch, fetchers, openStore, providers } = await import("@webmesh/core");
  const store = openStore();
  const env = mergeEnv(settings.keys, process.env);
  return {
    searcher: createSearch(providers, { store, cache: store, env, proxy: settings.proxy }),
    fetcher: createFetch(fetchers, {
      store,
      cache: store,
      env,
      proxy: settings.proxy,
      allowPrivateNetworks: settings.allowPrivateNetworks,
      allowPrivateHosts: settings.allowPrivateHosts,
    }),
  };
}

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
    const parsed = searchFilters.safeParse({
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

type SearchArgs = { limit?: string; only?: string; filters?: SearchFilters };
type FetchArgs = { formats?: string; schemaFile?: string; maxCharacters?: string; only?: string };
type SearchReady = { limit?: number; only?: ProviderId[]; filters?: SearchFilters };
type FetchReady = { formats?: FetchFormat[]; schema?: z.infer<typeof extractionSchema>; maxCharacters?: number; only?: FetcherId[] };
type Prepared<T> = { ok: true; options: T } | { ok: false; error: string };

async function prepareSearch({ limit, only, filters }: SearchArgs): Promise<Prepared<SearchReady>> {
  const parsedLimit = limit === undefined ? undefined : limitSchema.safeParse(Number(limit));
  if (parsedLimit && !parsedLimit.success) return { ok: false, error: "Limit must be a whole number from 1 to 20." };
  const { isProviderId } = await import("@webmesh/core");
  const requested = list(only);
  const unknown = requested?.filter((id) => !isProviderId(id));
  if (unknown?.length) return { ok: false, error: `Unknown provider(s): ${unknown.join(", ")}.` };
  return { ok: true, options: { limit: parsedLimit?.data, only: requested?.filter(isProviderId), filters } };
}

async function prepareFetch({ formats, schemaFile, maxCharacters, only }: FetchArgs): Promise<Prepared<FetchReady>> {
  const parsedFormats = formats === undefined ? undefined : fetchFormatsSchema.safeParse(list(formats));
  if (parsedFormats && !parsedFormats.success) return { ok: false, error: "Formats must be markdown, html, rawHtml, links, or json." };
  let schema: z.infer<typeof extractionSchema> | undefined;
  if (schemaFile) {
    try {
      const parsed = extractionSchema.safeParse(JSON.parse(readFileSync(schemaFile, "utf8")));
      if (!parsed.success) return { ok: false, error: "Schema file must contain a JSON object." };
      schema = parsed.data;
    } catch {
      return { ok: false, error: `Could not read schema file: ${schemaFile}.` };
    }
  }
  const parsedMax = maxCharacters === undefined ? undefined : maxCharactersSchema.safeParse(Number(maxCharacters));
  if (parsedMax && !parsedMax.success) return { ok: false, error: "Max characters must be a whole number from 1000 to 1000000." };
  const { isFetcherId } = await import("@webmesh/core");
  const requested = list(only);
  const unknown = requested?.filter((id) => !isFetcherId(id));
  if (unknown?.length) return { ok: false, error: `Unknown fetcher(s): ${unknown.join(", ")}.` };
  return { ok: true, options: { formats: parsedFormats?.data, schema, maxCharacters: parsedMax?.data, only: requested?.filter(isFetcherId) } };
}

async function runSearch(query: string, args: SearchArgs = {}): Promise<SearchResult> {
  if (!query) return { success: false, error: "Missing query." };
  const prepared = await prepareSearch(args);
  if (!prepared.ok) return { success: false, error: prepared.error };
  const { searcher } = await engines();
  return searcher.search(query, prepared.options);
}

async function runSearchMany(
  queries: readonly string[],
  args: SearchArgs = {},
): Promise<{ success: true; results: SearchedOne[] } | { success: false; error: string }> {
  const empty = queries.findIndex((query) => query.trim() === "");
  if (empty !== -1) return { success: false, error: `Query ${empty + 1} is empty.` };
  const prepared = await prepareSearch(args);
  if (!prepared.ok) return { success: false, error: prepared.error };
  const { searcher } = await engines();
  return { success: true, results: await searcher.searchMany(queries, prepared.options) };
}

async function runFetch(url: string | undefined, args: FetchArgs = {}): Promise<FetchResult> {
  const parsedUrl = pageUrl.safeParse(url);
  if (!parsedUrl.success) return { success: false, error: "Pass an http or https URL." };
  const prepared = await prepareFetch(args);
  if (!prepared.ok) return { success: false, error: prepared.error };
  const { fetcher } = await engines();
  return fetcher.fetch(parsedUrl.data, prepared.options);
}

async function runFetchMany(
  urls: readonly string[],
  args: FetchArgs = {},
): Promise<{ success: true; results: FetchedOne[] } | { success: false; error: string }> {
  const invalid = urls.filter((url) => !pageUrl.safeParse(url).success);
  if (invalid.length > 0) return { success: false, error: `Not an http or https URL: ${invalid.join(", ")}.` };
  const prepared = await prepareFetch(args);
  if (!prepared.ok) return { success: false, error: prepared.error };
  const { fetcher } = await engines();
  return { success: true, results: await fetcher.fetchMany(urls, prepared.options) };
}

async function serveMcp() {
  const [{ StdioServerTransport }, { createBrowser }, { createMcpServer }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@webmesh/core/browser"),
    import("./mcp"),
  ]);
  const { searcher, fetcher } = await engines();
  const browser = createBrowser(`webmesh-mcp-${process.pid}`, {
    restore: LOGIN_STATE,
    redact: process.env.WEBMESH_REVEAL_SECRETS !== "1",
    proxy: settings.proxy,
    allowPrivateNetworks: settings.allowPrivateNetworks,
    allowPrivateHosts: settings.allowPrivateHosts,
  });
  const server = createMcpServer({ version, searcher, fetcher, browser: agentBrowserPath() ? browser : undefined });
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
  -q, --queries <a,b>        also search these; repeatable, or comma-separate
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
webmesh fetch <url>...     fetch one or more pages (JSON)
      --format <markdown|html|rawHtml|links|json>
                              comma-separate formats, default: markdown
      --schema-file <path>  JSON schema for the json format
      --max-characters <n>   cut content at n characters (default 50000)
  -p, --providers <a,b>      only use these fetchers
webmesh agent-browser <command>    drive Chrome, e.g. open <url>, snapshot -i, click @e2
webmesh setup                add webmesh to every coding agent found on this machine
  -a, --agent <name>         only this agent (claude-code, codex, cursor, pi, opencode)
      --remove               take webmesh out again
webmesh setup proxy <url>    send scrapers, local fetches, and anonymous browsing through a proxy (--remove to stop)
webmesh setup allow <host:port>  let pages and fetches reach one local or private address, e.g. localhost:3000 (--remove to block again)
webmesh setup key <NAME>     save an API key such as EXA_API_KEY; reads it from stdin (--remove to delete)
webmesh login <url>          log in once in a visible browser; later browser sessions start logged in
webmesh logout               forget saved logins
webmesh logins               list the hosts you have saved logins for (JSON)
webmesh check                try every provider once; exits 1 if one looks broken (not just blocked)
webmesh providers            list search and fetch providers with cooldowns and health (JSON)
webmesh mcp                  run the MCP server over stdio`;

function safeEngineOutput(line: string): string {
  const cleaned = cleanEngineOutput(line);
  if (process.env.WEBMESH_REVEAL_SECRETS === "1") return cleaned;
  try {
    const parsed = z.json().safeParse(JSON.parse(cleaned));
    if (parsed.success) return JSON.stringify(redact(parsed.data));
  } catch {
    // Plain engine output is expected for commands that do not support JSON.
  }
  return String(redact(cleaned));
}

async function forwardEngineOutput(stream: ReadableStream<Uint8Array>, write: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) write(`${safeEngineOutput(line)}\n`);
  }
  pending += decoder.decode();
  if (pending !== "") write(safeEngineOutput(pending));
}

async function runEngine(bin: string, args: string[], launchEnv: Launch["env"] = {}): Promise<number> {
  const proc = Bun.spawn(engineArgs(bin, args), {
    env: { ...browserEnv(settings.proxy), ...launchEnv },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const timer = setTimeout(() => killTree(proc), BROWSER_TIMEOUT_MS);
  const [exitCode] = await Promise.all([
    proc.exited,
    forwardEngineOutput(proc.stdout, (text) => process.stdout.write(text)),
    forwardEngineOutput(proc.stderr, (text) => process.stderr.write(text)),
  ]);
  clearTimeout(timer);
  if (proc.signalCode) {
    console.error(`Webmesh agent-browser timed out after ${BROWSER_TIMEOUT_MS / 1000}s. Raise it with WEBMESH_AGENT_BROWSER_TIMEOUT_MS.`);
    return 1;
  }
  return exitCode;
}

const skillPayload = z.object({
  data: z.array(z.object({ content: z.string(), name: z.string() }).passthrough()),
}).passthrough();

function bundledAgentBrowserSkill(): string {
  const paths = [
    join(import.meta.dir, "skills", "agent-browser", "SKILL.md"),
    join(import.meta.dir, "../../../skills/agent-browser/SKILL.md"),
  ];
  const path = paths.find(existsSync);
  if (!path) throw new Error("The bundled webmesh agent-browser skill is missing.");
  return readFileSync(path, "utf8");
}

function adaptSkillDocument(content: string, name?: string): string {
  const skill = name ?? content.match(/^name:\s*([^\s]+)$/m)?.[1];
  if (!skill) throw new Error("The engine returned a skill without a name.");
  return adaptBrowserSkill(skill, skill === "core" ? bundledAgentBrowserSkill() : content);
}

async function captureEngine(bin: string, args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(engineArgs(bin, args), {
    env: browserEnv(settings.proxy),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const timer = setTimeout(() => killTree(proc), BROWSER_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr, stdout };
  } finally {
    clearTimeout(timer);
  }
}

async function runSkills(bin: string, args: string[], json: boolean): Promise<number> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "path") {
    console.error("webmesh does not expose unadapted skill files; use `webmesh agent-browser skills get <name> --full`.");
    return 1;
  }
  if (subcommand === "list" || args.length === 0) {
    const result = await captureEngine(bin, ["skills", "list", ...(json ? ["--json"] : [])]);
    if (result.exitCode !== 0) {
      console.error(safeEngineOutput(result.stderr.trim() || result.stdout.trim()));
      return result.exitCode;
    }
    if (!json) {
      const list = result.stdout
        .split("\n")
        .map(safeEngineOutput)
        .join("\n")
        .replace(/^(\s*)core\s+/m, "$1agent-browser  ");
      process.stdout.write(list);
      return 0;
    }
    try {
      const parsed = z.object({ data: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough()
        .parse(JSON.parse(result.stdout));
      const data = parsed.data.map((skill) => ({ ...skill, name: skill.name === "core" ? "agent-browser" : skill.name }));
      console.log(JSON.stringify({ ...parsed, data }));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (subcommand !== "get") return runEngine(bin, ["skills", ...args, ...(json ? ["--json"] : [])]);

  const requested = args.map((arg) => arg === "agent-browser" ? "core" : arg);
  const command = ["skills", ...requested, ...(requested.includes("--full") ? [] : ["--full"]), ...(json ? ["--json"] : [])];
  const result = await captureEngine(bin, command);
  if (result.exitCode !== 0) {
    console.error(safeEngineOutput(result.stderr.trim() || result.stdout.trim()));
    return result.exitCode;
  }

  try {
    if (json) {
      const parsed = skillPayload.parse(JSON.parse(result.stdout));
      const data = parsed.data.map((skill) => ({
        ...skill,
        content: adaptSkillDocument(skill.content, skill.name),
        name: skill.name === "core" ? "agent-browser" : skill.name,
      }));
      console.log(JSON.stringify({ ...parsed, data }));
      return 0;
    }
    const documents = result.stdout.split(/(?=^---\nname:)/m).filter((document) => document.trim() !== "");
    console.log(documents.map((document) => adaptSkillDocument(document)).join("\n").trimEnd());
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// The shared session outlives this process, so its private-network filter runs detached and is
// reused by every call. With allowPrivateNetworks the browser goes out directly or via the proxy.
async function cliLaunch(bin: string): Promise<Launch> {
  if (settings.allowPrivateNetworks) return launchFlags(bin, { restore: LOGIN_STATE, proxy: settings.proxy });
  const directHosts = (await loginBypass(bin)) ?? [];
  try {
    const url = await ensureBrowserFilter([process.execPath, Bun.main, "browser-filter"], {
      upstreamProxy: settings.proxy,
      directHosts,
      allowedHosts: settings.allowPrivateHosts ?? [],
    });
    return { flags: (await launchFlags(bin, { restore: LOGIN_STATE })).flags, env: filteredEnv(url) };
  } catch (error) {
    console.error(`Could not start the browser network filter: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[2] === "agent-browser") {
  const args = process.argv.slice(3);
  const bin = agentBrowserPath();
  const help = async (text: (found: string) => Promise<string>): Promise<never> => {
    console.log(bin ? await text(bin) : "Webmesh agent-browser support is not installed.");
    process.exit(bin ? 0 : 1);
  };
  if (args.length === 1 && args[0] === "--all") await help(browserReference);
  if (args.length === 0 || args[0] === "help" || args[0] === "--full-help" || args.includes("--help") || args.includes("-h")) {
    await help(browserUsage);
  }
  const prepared = prepareBrowserCommand(args);
  if ("error" in prepared) {
    console.error(prepared.error);
    process.exit(1);
  }
  if (!bin) {
    console.error("Webmesh agent-browser support is not installed.");
    process.exit(1);
  }
  const command = browserCommandName(prepared.args);
  if (command === "skills") {
    const index = prepared.args.indexOf(command);
    process.exit(await runSkills(bin, prepared.args.slice(index + 1), args.includes("--json")));
  }
  if (!settings.allowPrivateNetworks) {
    for (const arg of prepared.args) {
      if (!/^https?:\/\//i.test(arg)) continue;
      const error = await blockedUrl(arg, undefined, settings.allowPrivateHosts);
      if (error) {
        console.error(error);
        process.exit(1);
      }
    }
  }
  const external = command === "connect" || browserProvider(prepared.args) !== undefined;
  if (command !== "close" && !external) {
    const installError = await ensureBrowser(bin);
    if (installError) {
      console.error(installError);
      process.exit(1);
    }
  }
  const launch = external ? { flags: [], env: {} } : await cliLaunch(bin);
  const exitCode = await runEngine(bin, ["--session", "webmesh", ...launch.flags, ...prepared.args], launch.env);
  // The session is gone, so its filter has nothing left to guard.
  if (command === "close" && exitCode === 0) stopBrowserFilter();
  process.exit(exitCode);
}

if (process.argv[2] === "logins") {
  const bin = agentBrowserPath();
  if (!bin) {
    console.error("Webmesh agent-browser support is not installed.");
    process.exit(1);
  }
  const hosts = await loginHosts(bin);
  console.log(JSON.stringify({ success: hosts !== undefined, data: { hosts: hosts ?? [] } }, null, 2));
  process.exit(hosts === undefined ? 1 : 0);
}

if (process.argv[2] === "login" || process.argv[2] === "logout") {
  const bin = agentBrowserPath();
  if (!bin) {
    console.error("Webmesh agent-browser support is not installed.");
    process.exit(1);
  }
  const run = (args: string[]) => runEngine(bin, args);
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

const { values, positionals } = (() => {
  try {
    return parseArgs({
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
        queries: { type: "string", short: "q", multiple: true },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    console.log(USAGE);
    process.exit(1);
  }
})();

const [command, ...rest] = positionals;
const print = <T,>(value: T) => console.log(JSON.stringify(value, null, 2));

if (values.version) {
  console.log(version);
  process.exit(0);
}

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
  const queries = [...(values.queries ?? []).flatMap((value) => list(value) ?? []), ...(rest.length > 0 ? [rest.join(" ")] : [])];
  if (queries.length === 0) {
    print({ success: false, error: "Missing query." });
    process.exitCode = 1;
  } else if (queries.length === 1) {
    const result = parsedFilters.ok
      ? await runSearch(queries[0] ?? "", { limit: values.limit, only: values.providers, filters: parsedFilters.filters })
      : { success: false, error: parsedFilters.error };
    print(result);
    if (!result.success) process.exitCode = 1;
  } else {
    const result: { success: true; results: SearchedOne[] } | { success: false; error: string } = parsedFilters.ok
      ? await runSearchMany(queries, { limit: values.limit, only: values.providers, filters: parsedFilters.filters })
      : { success: false, error: parsedFilters.error };
    print(result);
    if (!result.success || result.results.some((entry) => !entry.success)) process.exitCode = 1;
  }
} else if (command === "fetch" && !values.help) {
  const args = {
    formats: values.format,
    schemaFile: values["schema-file"],
    maxCharacters: values["max-characters"],
    only: values.providers,
  };
  if (rest.length > 1) {
    const result: { success: true; results: FetchedOne[] } | { success: false; error: string } = await runFetchMany(rest, args);
    print(result);
    if (!result.success || result.results.some((entry) => !entry.success)) process.exitCode = 1;
  } else {
    const result = await runFetch(rest[0], args);
    print(result);
    if (!result.success) process.exitCode = 1;
  }
} else if (command === "setup" && !values.help) {
  const { allowHost, setKey, setProxy, setup } = await import("./setup");
  const [target, ...params] = rest;
  const remove = values.remove === true;
  let outcome: SetupResult;
  if (target === "proxy") outcome = setProxy(params[0], remove);
  else if (target === "allow") outcome = allowHost(params[0], remove);
  else if (target === "key" && params[1] !== undefined) {
    outcome = { ok: false, lines: [`Pass the key on stdin, not as an argument: webmesh setup key ${params[0]}`] };
  } else if (target === "key") outcome = await setKey(params[0], remove);
  else outcome = { ok: true, lines: await setup(values.agent, remove) };
  console.log(outcome.lines.join("\n"));
  if (!outcome.ok) process.exitCode = 1;
} else if (command === "check" && !values.help) {
  const { checkProviders } = await import("@webmesh/core");
  const results = await checkProviders(mergeEnv(settings.keys, process.env), settings.proxy);
  const broken = results.filter((result) => result.status === "broken");
  print({ success: broken.length === 0, data: results });
  if (broken.length > 0) process.exitCode = 1;
} else if (command === "providers") {
  const { usesProxy } = await import("@webmesh/core");
  const { searcher, fetcher } = await engines();
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
} else if (command === "browser-filter") {
  // The detached network filter for the CLI's browser session; see browserFilter.ts.
  await serveBrowserFilter(process.env[FILTER_ENV]);
} else {
  console.log(USAGE);
}
