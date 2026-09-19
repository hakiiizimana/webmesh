import { type Fetcher, fetchers } from "./fetch";
import { SoftBlockError } from "./html";
import { HttpError, NetworkError } from "./http";
import { usesProxy } from "./router";
import { providers } from "./webSearch";

const QUERY = "python programming language";
const PAGE = "https://sqlite.org/wal.html";
const PAGE_TEXT = "Write-Ahead";
const TIMEOUT_MS = 20_000;
const UNAVAILABLE_STATUSES = new Set([202, 401, 402, 403, 429]);

export type CheckResult = {
  kind: "search" | "fetch";
  id: string;
  status: "ok" | "unavailable" | "broken";
  ms: number;
  detail: string;
};

// "unavailable" is inconclusive (bot check, rate limit, outage); "broken" most likely needs a code fix.
export async function probe(kind: CheckResult["kind"], id: string, run: (signal: AbortSignal) => Promise<string>): Promise<CheckResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const detail = await run(AbortSignal.timeout(TIMEOUT_MS));
    return { kind, id, status: "ok", ms: ms(), detail };
  } catch (err) {
    const unavailable =
      err instanceof NetworkError ||
      err instanceof SoftBlockError ||
      (err instanceof HttpError && (UNAVAILABLE_STATUSES.has(err.status) || err.status >= 500)) ||
      (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));
    const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 160) ?? "";
    return { kind, id, status: unavailable ? "unavailable" : "broken", ms: ms(), detail };
  }
}

export function keyNames(): string[] {
  const names = [...Object.values(providers).map((p) => p.env), ...Object.values<Fetcher>(fetchers).map((f) => f.env)];
  return [...new Set(names.filter((name): name is string => name !== undefined))].sort();
}

export async function checkProviders(env: Record<string, string | undefined> = process.env, proxy?: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    const key = provider.env ? (env[provider.env] ?? "") : "";
    if (provider.env && !key) continue;
    const filters = provider.supports?.({}) === false ? { type: "video" as const } : {};
    results.push(
      await probe("search", id, async (signal) => {
        const items = await provider.search(QUERY, { limit: 3, signal, key, filters, proxy: usesProxy(provider.kind) ? proxy : undefined });
        if (items.length === 0) throw new Error("no results");
        return `${items.length} results`;
      }),
    );
  }
  for (const [id, fetcher] of Object.entries(fetchers)) {
    const result = await probeFetcher(id, fetcher, env, proxy);
    if (result) results.push(result);
  }
  return results;
}

async function probeFetcher(
  id: string,
  fetcher: Fetcher,
  env: Record<string, string | undefined>,
  proxy: string | undefined,
): Promise<CheckResult | undefined> {
  const key = fetcher.env ? (env[fetcher.env] ?? "") : "";
  if ((fetcher.env && !key) || !(fetcher.available?.() ?? true)) return undefined;
  return probe("fetch", id, async (signal) => {
    const page = await fetcher.fetch(PAGE, {
      format: "markdown",
      maxCharacters: 50_000,
      signal,
      key,
      proxy: usesProxy(fetcher.kind) ? proxy : undefined,
    });
    if (!page.content.includes(PAGE_TEXT)) throw new Error(`page is missing "${PAGE_TEXT}"`);
    return `${page.content.length} characters`;
  });
}
