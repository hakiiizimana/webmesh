import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { startNetworkProxy } from "./networkProxy";

// The CLI's browser session outlives each `webmesh agent-browser` call, so its network filter
// runs as a small detached process that every call reuses. It exits once nothing has used it
// for IDLE_MS; the next call starts it again on the same port the running browser points at.

const IDLE_MS = 30 * 60_000;
const START_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
export const FILTER_ENV = "WEBMESH_BROWSER_FILTER";

const filterConfig = z.object({
  upstreamProxy: z.string().optional(),
  directHosts: z.array(z.string()),
  allowedHosts: z.array(z.string()),
});
const filterRequest = z.object({ config: filterConfig, port: z.number().int().min(0).max(65_535) });
const filterState = z.object({ pid: z.number().int(), port: z.number().int(), config: z.string() });

export type FilterConfig = z.infer<typeof filterConfig>;

const defaultStatePath = () =>
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "webmesh", "browser-filter.json");

// A hash, so the state file never holds the upstream proxy's password.
function fingerprint(config: FilterConfig): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify({
      upstreamProxy: config.upstreamProxy ?? null,
      directHosts: [...config.directHosts].sort(),
      allowedHosts: [...config.allowedHosts].sort(),
    }),
  );
  return hasher.digest("hex");
}

function readState(path: string) {
  try {
    return filterState.safeParse(JSON.parse(readFileSync(path, "utf8"))).data;
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + START_TIMEOUT_MS * 2;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS || Date.now() > deadline) rmSync(lock, { force: true });
      else await Bun.sleep(50);
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { force: true });
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text.split("\n")[0] ?? "";
}

async function spawnFilter(command: string[], config: FilterConfig, port: number): Promise<{ pid: number; port: number }> {
  const proc = Bun.spawn(command, {
    env: { ...process.env, [FILTER_ENV]: JSON.stringify({ config, port }) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const timeout = Bun.sleep(START_TIMEOUT_MS).then(() => "");
  const line = await Promise.race([firstLine(proc.stdout), timeout]);
  const started = Number(line);
  if (!Number.isInteger(started) || started <= 0) {
    proc.kill();
    throw new Error("the browser network filter did not start");
  }
  proc.unref();
  return { pid: proc.pid, port: started };
}

/** Returns the URL of a running filter for `config`, starting or replacing one when needed. */
export async function ensureBrowserFilter(command: string[], config: FilterConfig, path = defaultStatePath()): Promise<string> {
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, async () => {
    const wanted = fingerprint(config);
    const state = readState(path);
    const alive = state !== undefined && isRunning(state.pid) && (await answers(state.port));
    if (alive && state.config === wanted) return `http://127.0.0.1:${state.port}`;
    if (state && isRunning(state.pid)) process.kill(state.pid);
    // Reuse the old port: a browser that is still running keeps pointing at it.
    const started = await spawnFilter(command, config, state?.port ?? 0);
    writeFileSync(path, JSON.stringify({ ...started, config: wanted }), { mode: 0o600 });
    return `http://127.0.0.1:${started.port}`;
  });
}

export function stopBrowserFilter(path = defaultStatePath()): void {
  const state = readState(path);
  if (state && isRunning(state.pid)) process.kill(state.pid);
  rmSync(path, { force: true });
}

/** The detached process's side: serve until idle, printing the port once listening. */
export async function serveBrowserFilter(payload: string | undefined): Promise<void> {
  const request = filterRequest.parse(JSON.parse(payload ?? "null"));
  const options = request.config;
  const proxy = await startNetworkProxy({ ...options, port: request.port }).catch(() => startNetworkProxy({ ...options, port: 0 }));
  process.stdout.write(`${proxy.port}\n`);
  let lastUsed = Date.now();
  setInterval(() => {
    if (proxy.server.getConnectionIds().length > 0) lastUsed = Date.now();
    else if (Date.now() - lastUsed > IDLE_MS) void proxy.close().then(() => process.exit(0));
  }, 15_000);
}
