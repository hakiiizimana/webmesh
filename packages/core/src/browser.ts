import { dirname, join } from "node:path";
import { z } from "zod";

const TIMEOUT_MS = 60_000;
const MAX_FIELD = 30_000;
export const LOGIN_STATE = "webmesh";

const SECRET_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|jwt|credential|bearer/i;
const SECRET_PARAM = /([?&#](?:access_token|id_token|refresh_token|token|api_key|apikey|key|secret|client_secret|password|sig|signature)=)[^&#\s"']+/gi;
const SECRET_VALUES = [
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];
const REDACTED = "[redacted]";

const browserData = z.record(z.string(), z.json());
const output = z.object({ success: z.boolean(), data: browserData.nullish(), error: z.string().nullish() });

type BrowserData = z.infer<typeof browserData>;

export type BrowserResult = { success: true; data: BrowserData } | { success: false; error: string };

let launcher: string | null | undefined;

export function agentBrowserPath(): string | null {
  if (launcher !== undefined) return launcher;
  try {
    launcher = join(dirname(Bun.resolveSync("agent-browser/package.json", import.meta.dir)), "bin", "agent-browser.js");
  } catch {
    launcher = null;
  }
  return launcher;
}

function hint(error: string): string {
  if (/unknown ref/i.test(error)) return `${error}. Refs change when the page changes; run snapshot -i again.`;
  if (/failed to launch chrome|chrome not found|no chrome/i.test(error)) {
    return `${error}. Run \`webmesh browser install\` to download Chrome.`;
  }
  return error;
}

type JsonValue = BrowserData[string];

function redactText(text: string): string {
  return SECRET_VALUES.reduce((out, pattern) => out.replace(pattern, REDACTED), text.replace(SECRET_PARAM, `$1${REDACTED}`));
}

export function redact(value: JsonValue, key = ""): JsonValue {
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value !== null && value instanceof Object) {
    const isCookie = Object.hasOwn(value, "name") && Object.hasOwn(value, "value") && Object.hasOwn(value, "domain");
    return Object.fromEntries(
      Object.entries(value).map(([name, inner]) => [name, isCookie && name === "value" ? REDACTED : redact(inner, name)]),
    );
  }
  if (SECRET_KEY.test(key) && value !== null && value !== "" && value !== false) return REDACTED;
  return z.string().safeParse(value).success ? redactText(String(value)) : value;
}

function trim(data: BrowserData): BrowserData {
  const { lifecycle: _lifecycle, ...rest } = data;
  if (Object.hasOwn(rest, "snapshot")) delete rest.refs;
  for (const [key, value] of Object.entries(rest)) {
    const text = z.string().min(MAX_FIELD + 1).safeParse(value);
    if (text.success) rest[key] = `${text.data.slice(0, MAX_FIELD)}\n… cut at ${MAX_FIELD} characters`;
  }
  return rest;
}

export function parseOutput(stdout: string, stderr: string, exitCode: number): BrowserResult {
  const line = stdout.trim().split("\n").findLast((candidate) => candidate.startsWith("{"));
  const parsed = line ? output.safeParse(JSON.parse(line)) : undefined;
  if (parsed?.success) {
    if (!parsed.data.success) return { success: false, error: hint(parsed.data.error ?? "agent-browser failed") };
    return { success: true, data: trim(parsed.data.data ?? {}) };
  }
  if (exitCode === 0 && stdout.trim()) return { success: true, data: trim({ output: stdout.trim() }) };
  return { success: false, error: hint((stderr || stdout).trim().split("\n")[0] ?? `agent-browser exited with ${exitCode}`) };
}

type BrowserOptions = { restore?: string; redact?: boolean };

export function createBrowser(session: string, { restore, redact: hide = false }: BrowserOptions = {}) {
  let used = false;
  const launch = restore ? ["--restore", restore, "--restore-save", "never"] : [];
  let queue: Promise<BrowserResult | undefined> = Promise.resolve(undefined);

  // One page, one command at a time: parallel tool calls would race each other.
  function run(args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    const next = queue.then(() => execute(args, signal));
    queue = next.catch(() => undefined);
    return next;
  }

  async function execute(args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    const bin = agentBrowserPath();
    if (!bin) return { success: false, error: "agent-browser is not installed." };
    if (args.some((arg) => arg === "--session" || arg.startsWith("--session="))) {
      return { success: false, error: "webmesh manages the browser session; drop --session." };
    }
    used = true;
    const proc = Bun.spawn([process.execPath, bin, "--json", "--session", session, ...launch, ...args.filter((arg) => arg !== "--json")], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const kill = () => proc.kill();
    const timer = setTimeout(kill, TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (signal?.aborted) return { success: false, error: "cancelled" };
      if (proc.signalCode) return { success: false, error: `agent-browser timed out after ${TIMEOUT_MS / 1000}s` };
      const result = parseOutput(stdout, stderr, exitCode);
      if (!hide || !result.success) return result;
      return { success: true, data: Object.fromEntries(Object.entries(result.data).map(([key, value]) => [key, redact(value, key)])) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    }
  }

  async function close(): Promise<void> {
    if (used) await run(["close"]);
  }

  return { session, run, close };
}
