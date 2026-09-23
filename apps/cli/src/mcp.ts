import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { createBrowser } from "@webmesh/core/browser";
import {
  type createFetch,
  type createSearch,
  fetcherIds,
  type fetchers,
  fetchFormat,
  page,
  providerIds,
  type providers,
  searchFilters,
  searchItem,
} from "@webmesh/core";
import { z } from "zod";

// Enough for an agent's usual fan-out, small enough that one call can't flood the user's IP.
export const MAX_BATCH = 10;

export const limitSchema = z.number().int().min(1).max(20);
export const pageUrl = z.url({ protocol: /^https?$/ });
export const fetchFormatsSchema = z.array(fetchFormat).min(1).max(5);
export const extractionSchema = z.record(z.string(), z.json());
export const maxCharactersSchema = z.number().int().min(1_000).max(1_000_000);
const screenshot = z.object({ path: z.string().regex(/\.(png|jpe?g|webp)$/i) });
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as const;
const isImageType = (ext: string): ext is keyof typeof IMAGE_TYPES => Object.hasOwn(IMAGE_TYPES, ext);

const searchOutput = {
  success: z.boolean(),
  data: z.array(searchItem).optional(),
  error: z.string().optional(),
  results: z
    .array(z.object({ query: z.string(), success: z.boolean(), data: z.array(searchItem).optional(), error: z.string().optional() }))
    .optional(),
};

const fetchOutput = {
  success: z.boolean(),
  data: page.optional(),
  error: z.string().optional(),
  results: z.array(z.object({ url: z.string(), success: z.boolean(), data: page.optional(), error: z.string().optional() })).optional(),
};

type Deps = {
  version: string;
  searcher: Pick<ReturnType<typeof createSearch<typeof providers>>, "search" | "searchMany">;
  fetcher: Pick<ReturnType<typeof createFetch<typeof fetchers>>, "fetch" | "fetchMany">;
  browser?: Pick<ReturnType<typeof createBrowser>, "run">;
};

// Text for clients that only read content, structuredContent for clients that honor outputSchema.
function reply<T extends { success: boolean }>(value: T, failed = !value.success): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: failed };
}

export function createMcpServer({ version, searcher, fetcher, browser }: Deps): McpServer {
  const server = new McpServer({ name: "webmesh", version });
  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Search the web. Returns JSON: { success, data: [{ title, url, description, publishedAt? }] } or { success: false, error }. " +
        "publishedAt is YYYY-MM-DD when the provider reports it. " +
        `Pass query for one search, or queries for up to ${MAX_BATCH} in one call; several return { success, results: [{ query, ... }] }. ` +
        "Routes to the most reliable free search providers, falls back when one fails or is slow, " +
        "and uses keyed providers only when free ones can't answer.",
      inputSchema: {
        query: z.string().min(1).optional().describe("What to search for."),
        queries: z.array(z.string().min(1)).min(1).max(MAX_BATCH).optional().describe("Several searches in one call."),
        limit: limitSchema.optional().describe("Max results (default 10)."),
        providers: z.array(z.enum(providerIds)).optional().describe("Only use these providers."),
        filters: searchFilters.optional().describe("Provider-neutral search filters."),
      },
      outputSchema: searchOutput,
    },
    async ({ query, queries, limit, providers: only, filters }, { signal }) => {
      if ((query === undefined) === (queries === undefined)) return reply({ success: false, error: "Pass query or queries, not both." });
      if (queries) {
        const results = await searcher.searchMany(queries, { limit, only, filters, signal });
        return reply({ success: true, results }, results.some((entry) => !entry.success));
      }
      return reply(await searcher.search(query ?? "", { limit, only, filters, signal }));
    },
  );
  server.registerTool(
    "web_fetch",
    {
      title: "Fetch a page",
      description:
        "Fetch a web page and return one or more representations: markdown, cleaned HTML, raw HTML, links, or schema-shaped JSON. " +
        "Returns JSON: { success, data: { url, title, format, content, metadata, rawHtml?, links?, json?, media?, truncated } }. " +
        `Pass url for one page, or urls for up to ${MAX_BATCH} in one call; several return { success, results: [{ url, ... }] }. ` +
        "Tries a local fetch first, then remote readers, and uses keyed readers only when free ones can't answer.",
      inputSchema: {
        url: pageUrl.optional().describe("The http or https page to fetch."),
        urls: z.array(pageUrl).min(1).max(MAX_BATCH).optional().describe("Several pages in one call."),
        format: fetchFormat.optional().describe("One format; markdown is the default."),
        formats: fetchFormatsSchema.optional().describe("One or more output formats."),
        schema: extractionSchema.optional().describe("JSON Schema-like object used when formats includes json."),
        maxCharacters: maxCharactersSchema.optional().describe("Cut content and raw HTML at this many characters (default 50000)."),
        providers: z.array(z.enum(fetcherIds)).optional().describe("Only use these fetchers."),
      },
      outputSchema: fetchOutput,
    },
    async ({ url, urls, format, formats, schema, maxCharacters, providers: only }, { signal }) => {
      if ((url === undefined) === (urls === undefined)) return reply({ success: false, error: "Pass url or urls, not both." });
      if (format && formats) return reply({ success: false, error: "Pass format or formats, not both." });
      const options = { formats: formats ?? (format ? [format] : undefined), schema, maxCharacters, only, signal };
      if (urls) {
        const results = await fetcher.fetchMany(urls, options);
        return reply({ success: true, results }, results.some((entry) => !entry.success));
      }
      return reply(await fetcher.fetch(url ?? "", options));
    },
  );
  if (!browser) return server;
  server.registerTool(
    "agent-browser",
    {
      title: "Agent browser",
      description:
        "Drive a real Chrome browser: open pages, click, type, read, and take screenshots. Pass one browser command as args. " +
        'Loop: ["open", url], then ["snapshot", "-i"] to list interactive elements as @e1, @e2, then ["click", "@e2"], ' +
        '["fill", "@e3", "text"], or ["press", "Enter"]. Run ["snapshot", "-i"] again after the page changes; refs go stale. ' +
        '["screenshot", "--annotate"] labels elements with their refs; add "--if-changed" to skip unchanged images. ' +
        '["read"] returns the rendered page as text. Also ["get", "text", "@e1"], ["select", "@e4", "value"], ["upload", "@e5", "/path"], ' +
        '["scroll", "down"], ["tab", "list"], ["back"]. Run `webmesh agent-browser --help` for the command list. ' +
        '["console"] and ["errors"] read the page\'s logs, ["eval", "js"] runs script, ["set", "viewport", "390", "844"] emulates a device, ' +
        '["pushstate", "/path"] navigates a single-page app without a reload. ' +
        "Use absolute paths for pdf, upload, and --screenshot-dir; relative paths resolve from the browser's background process. " +
        "Sessions start with the logins saved by `webmesh login`. Secrets in output are redacted. " +
        "The session belongs to this server and closes when it exits. Returns JSON: { success, data } or { success, error }.",
      inputSchema: {
        args: z.array(z.string()).min(1).describe('One browser command, e.g. ["click", "@e2"].'),
      },
    },
    async ({ args }, { signal }) => {
      const result = await browser.run(args, signal);
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
  return server;
}
