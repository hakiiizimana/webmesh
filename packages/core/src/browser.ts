import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { blockedUrl, type ResolveAddresses } from "./network";
import { startNetworkProxy } from "./networkProxy";

const TIMEOUT_MS = 60_000;
const MAX_FIELD = 30_000;
export const LOGIN_STATE = "webmesh";

export const BROWSER_GROUPS = ["navigation", "interact", "files", "advanced"] as const;
type BrowserGroup = (typeof BROWSER_GROUPS)[number];

const GROUP_TITLES = {
  navigation: "Navigation",
  interact: "Inspect and interact",
  files: "Files and tabs",
  advanced: "Advanced",
} satisfies Record<BrowserGroup, string>;

type BrowserCommand = {
  readonly name: string;
  readonly group: BrowserGroup;
  readonly usage: string;
  readonly summary: string;
};

const BROWSER_COMMANDS = [
  { name: "open", group: "navigation", usage: "open <url>", summary: "open a page" },
  { name: "back", group: "navigation", usage: "back", summary: "go back" },
  { name: "forward", group: "navigation", usage: "forward", summary: "go forward" },
  { name: "reload", group: "navigation", usage: "reload", summary: "reload the page" },
  { name: "snapshot", group: "interact", usage: "snapshot -i", summary: "list interactive elements as @e1, @e2, ..." },
  { name: "read", group: "interact", usage: "read", summary: "read the rendered page" },
  { name: "click", group: "interact", usage: "click <ref>", summary: "click an element" },
  { name: "dblclick", group: "interact", usage: "dblclick <ref>", summary: "double-click an element" },
  { name: "fill", group: "interact", usage: "fill <ref> <text>", summary: "clear and fill a field" },
  { name: "type", group: "interact", usage: "type <ref> <text>", summary: "type without clearing" },
  { name: "keyboard", group: "interact", usage: "keyboard type <text>", summary: "type with keyboard events" },
  { name: "press", group: "interact", usage: "press <key>", summary: "press Enter, Tab, or another key" },
  { name: "hover", group: "interact", usage: "hover <ref>", summary: "hover an element" },
  { name: "focus", group: "interact", usage: "focus <ref>", summary: "focus an element" },
  { name: "check", group: "interact", usage: "check <ref>", summary: "check a checkbox" },
  { name: "uncheck", group: "interact", usage: "uncheck <ref>", summary: "uncheck a checkbox" },
  { name: "select", group: "interact", usage: "select <ref> <value>", summary: "select an option" },
  { name: "drag", group: "interact", usage: "drag <from> <to>", summary: "drag an element" },
  { name: "scroll", group: "interact", usage: "scroll <direction>", summary: "scroll up, down, left, or right" },
  { name: "scrollintoview", group: "interact", usage: "scrollintoview <ref>", summary: "scroll an element into view" },
  { name: "wait", group: "interact", usage: "wait <ref-or-ms>", summary: "wait for a page or element" },
  { name: "get", group: "interact", usage: "get <what> <ref>", summary: "read text, HTML, values, attributes, URL, or title" },
  { name: "is", group: "interact", usage: "is <what> <ref>", summary: "check visibility, enabled, or checked state" },
  { name: "find", group: "interact", usage: "find <kind> <value>", summary: "find by role, text, label, placeholder, or test id" },
  { name: "screenshot", group: "files", usage: "screenshot <absolute-path>", summary: "save a screenshot" },
  { name: "pdf", group: "files", usage: "pdf <absolute-path>", summary: "save a PDF" },
  { name: "upload", group: "files", usage: "upload <ref> <absolute-path>", summary: "upload a file" },
  { name: "download", group: "files", usage: "download <ref> <absolute-path>", summary: "download a file" },
  { name: "tab", group: "files", usage: "tab list | new | close <n>", summary: "manage tabs" },
  { name: "close", group: "files", usage: "close", summary: "close the Webmesh browser session" },
  { name: "network", group: "advanced", usage: "network <action>", summary: "inspect or export network traffic" },
  { name: "cookies", group: "advanced", usage: "cookies <action>", summary: "inspect or manage cookies" },
  { name: "storage", group: "advanced", usage: "storage <kind>", summary: "inspect local or session storage" },
  { name: "diff", group: "advanced", usage: "diff <kind>", summary: "compare snapshots, screenshots, or URLs" },
  { name: "vitals", group: "advanced", usage: "vitals", summary: "measure page performance" },
  { name: "a11y", group: "advanced", usage: "a11y", summary: "run an accessibility audit" },
] satisfies readonly BrowserCommand[];

export const BROWSER_ALIASES = {
  inspect: ["snapshot", "-i"],
  tabs: ["tab", "list"],
  "new-tab": ["tab", "new"],
  "close-tab": ["tab", "close"],
} as const satisfies Record<string, readonly string[]>;

export const WEBMESH_BROWSER_COMMANDS: ReadonlySet<string> = new Set([
  ...BROWSER_COMMANDS.map((command) => command.name),
  ...Object.keys(BROWSER_ALIASES),
]);

// Flags webmesh sets itself. An agent passing them would retarget or re-format the session webmesh owns.
const OWNED_FLAGS = ["--session", "--namespace"] as const;
// webmesh always answers in JSON, so this is accepted and dropped rather than refused.
const STRIPPED_FLAGS = ["--json"] as const;

const BLOCKED_FLAGS = {
  "attach to a browser webmesh does not control": ["--cdp", "--auto-connect", "--port"],
  "hand the page to a cloud browser": ["--provider"],
  "read or write login state outside webmesh login": [
    "--profile", "--state", "--restore", "--restore-save", "--restore-check-url", "--restore-check-text",
    "--restore-check-fn", "--session-name",
  ],
  "run another binary or engine": [
    "--executable-path", "--engine", "--extension", "--init-script", "--enable", "--args",
  ],
  "reach local files": ["--allow-file-access"],
  "replace webmesh network controls": [
    "--proxy", "--proxy-bypass", "--allowed-domains", "--action-policy", "--confirm-actions", "--confirm-interactive",
  ],
  "load another config file": ["--config"],
  "weaken TLS": ["--ignore-https-errors", "--ca-cert", "--no-ca-cert"],
} satisfies Record<string, readonly string[]>;

const BLOCKED = new Map(
  Object.entries(BLOCKED_FLAGS).flatMap(([reason, flags]) => flags.map((flag) => [flag, reason] as const)),
);
const OWNED = new Set<string>(OWNED_FLAGS);
const STRIPPED = new Set<string>(STRIPPED_FLAGS);

function flagName(arg: string): string {
  if (!arg.startsWith("--")) return "";
  return arg.split("=")[0] ?? arg;
}

function expandAlias(name: string): readonly string[] | undefined {
  return Object.entries(BROWSER_ALIASES).find(([alias]) => alias === name)?.[1];
}

export type PreparedBrowserCommand = { args: string[] } | { error: string };

export function prepareBrowserCommand(input: string[]): PreparedBrowserCommand {
  const [name, ...rest] = input;
  if (!name) return { error: "Pass one browser command. Run `webmesh browser --help`." };
  const expansion = expandAlias(name);
  const expanded = expansion ? [...expansion, ...rest] : input;
  const [command, ...args] = expanded;
  if (!command || command.startsWith("-")) {
    return { error: `Pass a browser command, not \`${command ?? ""}\`. Run \`webmesh browser --help\`.` };
  }
  if (!WEBMESH_BROWSER_COMMANDS.has(command)) {
    return { error: `Unknown Webmesh browser command: ${command}. Run \`webmesh browser --help\`.` };
  }
  if (command === "close" && args.includes("--all")) {
    return { error: "webmesh cannot close browser sessions owned by other agents; drop --all." };
  }
  for (const arg of args) {
    const flag = flagName(arg);
    if (OWNED.has(flag)) return { error: `webmesh manages ${flag}; drop it.` };
    const reason = BLOCKED.get(flag);
    if (reason) return { error: `${flag} is not available through webmesh: it would ${reason}.` };
  }
  return { args: expanded.filter((arg) => !STRIPPED.has(flagName(arg))) };
}

export function browserUsage(): string {
  const lines = [
    "webmesh browser <command>",
    "",
    "Webmesh keeps one browser session, restores saved logins, applies its proxy,",
    "and redacts secrets. Run one command at a time.",
  ];
  for (const group of BROWSER_GROUPS) {
    const commands = BROWSER_COMMANDS.filter((command) => command.group === group);
    const width = Math.max(...commands.map((command) => command.usage.length));
    lines.push("", GROUP_TITLES[group]);
    for (const command of commands) {
      lines.push(`  ${`webmesh browser ${command.usage}`.padEnd(17 + width)} ${command.summary}`);
    }
  }
  const shortcuts = Object.entries(BROWSER_ALIASES).map(([alias, expansion]) => `${alias} = ${expansion.join(" ")}`);
  lines.push(
    "",
    `Shortcuts: ${shortcuts.join(", ")}`,
    "",
    "Use absolute paths for PDFs, uploads, and --screenshot-dir. Re-run snapshot -i",
    "after navigation because element refs go stale. close --all is not available.",
    "",
    "Run `webmesh browser --all` for the full reference, including the flags webmesh refuses.",
    "",
    "Examples",
    "  webmesh browser open https://example.com",
    "  webmesh browser snapshot -i",
    "  webmesh browser click @e2",
    "  webmesh browser screenshot /tmp/example.png",
  );
  return lines.join("\n");
}

export function browserReference(): string {
  const lines = [browserUsage(), "", "Flags webmesh refuses", ""];
  for (const [reason, flags] of Object.entries(BLOCKED_FLAGS)) {
    lines.push(`  ${reason}`, `    ${flags.join(", ")}`);
  }
  lines.push(
    "",
    `Flags webmesh sets itself, so do not pass them: ${OWNED_FLAGS.join(", ")}`,
    `Flags webmesh accepts and drops: ${STRIPPED_FLAGS.join(", ")}`,
    "",
    "Every other bundled flag passes through unchanged.",
  );
  return lines.join("\n");
}

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
const PROXY_ENV = /^(https?_proxy|all_proxy|no_proxy|agent_browser_proxy(_bypass)?)$/i;

const savedLogin = z.object({
  cookies: z.array(z.object({ domain: z.string() })).default([]),
  origins: z.array(z.object({ origin: z.string() })).default([]),
});

const browserData = z.record(z.string(), z.json());
const output = z.object({ success: z.boolean(), data: browserData.nullish(), error: z.string().nullish() });

type BrowserData = z.infer<typeof browserData>;

export type BrowserResult = { success: true; data: BrowserData } | { success: false; error: string };

let launcher: string | null | undefined;
let browserInstall: Promise<string | undefined> | undefined;

export function agentBrowserPath(): string | null {
  if (launcher !== undefined) return launcher;
  try {
    launcher = join(dirname(Bun.resolveSync("agent-browser/package.json", import.meta.dir)), "bin", "agent-browser.js");
  } catch {
    launcher = null;
  }
  return launcher;
}

function hasSystemBrowser(): boolean {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ].some(existsSync);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      localAppData && `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
    ].some((path) => path !== undefined && existsSync(path));
  }
  return ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"].some((command) => Bun.which(command));
}

// MCP uses stdout for its protocol, so installation stays quiet.
export function ensureBrowser(bin: string): Promise<string | undefined> {
  if (hasSystemBrowser()) return Promise.resolve(undefined);
  return (browserInstall ??= (async () => {
    const proc = Bun.spawn([process.execPath, bin, "install"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) return undefined;
    const detail = (stderr || stdout).trim().split("\n")[0];
    return detail ? `Could not install Chromium: ${detail}` : "Could not install Chromium.";
  })());
}

function hint(error: string): string {
  if (/unknown ref/i.test(error)) return `${error}. Refs change when the page changes; run snapshot -i again.`;
  if (/failed to launch chrome|chrome not found|no chrome/i.test(error)) {
    return `${error}. The Chromium installed with webmesh could not start; reinstall @hakiizimana/webmesh.`;
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
  return { success: false, error: hint((stderr || stdout).trim().split("\n")[0] ?? `Webmesh browser exited with ${exitCode}`) };
}

export function bypassFor(states: string[]): string[] | undefined {
  const hosts = new Set<string>();
  for (const text of states) {
    let state;
    try {
      state = savedLogin.safeParse(JSON.parse(text));
    } catch {
      return undefined;
    }
    if (!state.success) return undefined;
    for (const cookie of state.data.cookies) hosts.add(cookie.domain.replace(/^\./, ""));
    for (const origin of state.data.origins) {
      const host = URL.parse(origin.origin)?.hostname;
      if (host) hosts.add(host);
    }
  }
  return [...hosts].sort().flatMap((host) => [host, `*.${host}`]);
}

async function loginBypass(bin: string): Promise<string[] | undefined> {
  try {
    const proc = Bun.spawn([process.execPath, bin, "--json", "state", "list"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const listed = parseOutput(await new Response(proc.stdout).text(), "", await proc.exited);
    const dir = z.object({ directory: z.string() }).safeParse(listed.success ? listed.data : null);
    if (!dir.success) return undefined;
    const files = readdirSync(dir.data.directory).filter((file) => file.startsWith(`${LOGIN_STATE}-`) && file.endsWith(".json"));
    return bypassFor(files.map((file) => readFileSync(join(dir.data.directory, file), "utf8")));
  } catch {
    return undefined;
  }
}

// Sites you logged into always go direct: a login used from a proxy IP gets challenged or locked.
export async function launchFlags(bin: string, { restore, proxy }: { restore?: string; proxy?: string }): Promise<string[]> {
  const flags = restore ? ["--restore", restore, "--restore-save", "never"] : [];
  if (!proxy) return flags;
  const bypass = restore ? await loginBypass(bin) : [];
  if (bypass === undefined) return flags;
  flags.push("--proxy", proxy);
  if (bypass.length > 0) flags.push("--proxy-bypass", bypass.join(","));
  return flags;
}

export function browserEnv(proxy: string | undefined): Record<string, string | undefined> {
  if (!proxy) return process.env;
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !PROXY_ENV.test(name)));
}

type BrowserOptions = { restore?: string; redact?: boolean; proxy?: string; allowPrivateNetworks?: boolean; resolve?: ResolveAddresses };

export function createBrowser(
  session: string,
  { restore, redact: hide = false, proxy, allowPrivateNetworks = false, resolve }: BrowserOptions = {},
) {
  let used = false;
  let closed = false;
  let launch: Promise<string[]> | undefined;
  let filter: ReturnType<typeof startNetworkProxy> | undefined;
  let queue: Promise<BrowserResult | undefined> = Promise.resolve(undefined);

  // One page, one command at a time: parallel tool calls would race each other.
  function run(args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    const next = queue.then(() => execute(args, signal));
    queue = next.catch(() => undefined);
    return next;
  }

  async function execute(args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    const prepared = prepareBrowserCommand(args);
    if ("error" in prepared) return { success: false, error: prepared.error };
    args = prepared.args;
    const bin = agentBrowserPath();
    if (!bin) return { success: false, error: "Webmesh browser support is not installed." };
    if (args[0] !== "close") {
      const installError = await ensureBrowser(bin);
      if (installError) return { success: false, error: installError };
    }
    if (!allowPrivateNetworks) {
      for (const arg of args) {
        if (!/^https?:\/\//i.test(arg)) continue;
        const error = await blockedUrl(arg, resolve);
        if (error) return { success: false, error };
      }
    }
    used = true;
    const flags = await (launch ??= (async () => {
      if (allowPrivateNetworks) return launchFlags(bin, { restore, proxy });
      const directHosts = restore ? (await loginBypass(bin)) ?? [] : [];
      filter = startNetworkProxy({ upstreamProxy: proxy, directHosts, resolve });
      const network = await filter;
      return [...(await launchFlags(bin, { restore })), "--proxy", network.url];
    })());
    const proc = Bun.spawn([process.execPath, bin, "--json", "--session", session, ...flags, ...args], {
      env: browserEnv(proxy),
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
      if (proc.signalCode) return { success: false, error: `Webmesh browser timed out after ${TIMEOUT_MS / 1000}s` };
      const result = parseOutput(stdout, stderr, exitCode);
      if (!hide || !result.success) return result;
      return { success: true, data: Object.fromEntries(Object.entries(result.data).map(([key, value]) => [key, redact(value, key)])) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      if (used) await run(["close"]);
    } finally {
      await (await filter)?.close();
    }
  }

  return { session, run, close };
}
