import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { blockedUrl, type ResolveAddresses } from "./network";
import { startNetworkProxy } from "./networkProxy";

const TIMEOUT_MS = z.coerce.number().int().positive().catch(60_000).parse(
  process.env.WEBMESH_AGENT_BROWSER_TIMEOUT_MS ?? process.env.WEBMESH_BROWSER_TIMEOUT_MS,
);
// detectSystemBrowser prefers a real Chrome, so this is the escape hatch when the download fails.
const CHROME_FIX = "Install Chrome or Chromium for your platform and webmesh will use it instead.";
const MAX_FIELD = 30_000;
const CUT_HINT = "rerun narrower: snapshot -d or -s, read --outline";
export const LOGIN_STATE = "webmesh";
export const BROWSER_TIMEOUT_MS = TIMEOUT_MS;

// Flags webmesh sets itself. An agent passing them would retarget the browser webmesh owns.
const OWNED_FLAGS = ["--namespace", "--config"] as const;
// Upstream skills name their own session. Webmesh safely ignores that value and keeps its one
// managed session; --json is likewise redundant because the MCP path already requests JSON.
const STRIPPED_FLAGS = ["--json"] as const;
const STRIPPED_VALUE_FLAGS = ["--session"] as const;

const BLOCKED_FLAGS = {
  "attach to an arbitrary browser endpoint": ["--cdp", "--auto-connect", "--port"],
  "read or write login state outside webmesh login": [
    "--profile", "--state", "--restore", "--restore-save", "--restore-check-url", "--restore-check-text",
    "--restore-check-fn", "--session-name",
  ],
  "run another binary or engine": ["--executable-path", "--engine", "--extension", "--args"],
  "purge state or reinstall the engine": ["--fix"],
  "reach local files": ["--allow-file-access"],
  "replace webmesh network controls": [
    "--proxy", "--proxy-bypass", "--allowed-domains", "--action-policy", "--confirm-actions", "--confirm-interactive",
  ],
  "weaken TLS": ["--ignore-https-errors", "--ca-cert", "--no-ca-cert"],
} satisfies Record<string, readonly string[]>;

// Plugins execute third-party host code. batch accepts opaque command strings, so its contents
// cannot be checked by the argument policy. All other bundled commands pass through.
const DENIED_COMMANDS = new Map([
  ["plugin", "run third-party code inside the browser"],
  ["batch", "hide a refused flag inside a command string"],
  ["auth", "store credentials outside webmesh login"],
  ["state", "read or write login state outside webmesh login"],
  ["mcp", "start a second browser command server outside webmesh's policy"],
  ["upgrade", "replace the engine bundled with this webmesh version"],
]);

const BLOCKED = new Map(
  Object.entries(BLOCKED_FLAGS).flatMap(([reason, flags]) => flags.map((flag) => [flag, reason] as const)),
);
const OWNED = new Set<string>(OWNED_FLAGS);
const STRIPPED = new Set<string>(STRIPPED_FLAGS);
const STRIPPED_VALUE = new Set<string>(STRIPPED_VALUE_FLAGS);
const LEADING_VALUE_FLAGS = new Set(["-p", "--provider", "--init-script", "--enable", "--color-scheme"]);

function flagName(arg: string): string {
  if (!arg.startsWith("-")) return "";
  return arg.split("=")[0] ?? arg;
}

function flagValue(args: readonly string[], index: number): string | undefined {
  const equals = args[index]?.indexOf("=") ?? -1;
  return equals >= 0 ? args[index]?.slice(equals + 1) : args[index + 1];
}

function commandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    const flag = flagName(arg);
    if (!flag) return index;
    if (!LEADING_VALUE_FLAGS.has(flag)) return -1;
    index += arg.includes("=") ? 1 : 2;
  }
  return -1;
}

export function browserCommandName(args: readonly string[]): string | undefined {
  const index = commandIndex(args);
  return index >= 0 ? args[index] : undefined;
}

export function browserProvider(args: readonly string[]): string | undefined {
  const index = args.findIndex((arg) => ["-p", "--provider"].includes(flagName(arg)));
  return index >= 0 ? flagValue(args, index) : undefined;
}

function workspaceScript(value: string | undefined): boolean {
  if (!value || ![".js", ".mjs", ".cjs"].includes(extname(value))) return false;
  try {
    const path = realpathSync(resolve(value));
    const fromCwd = relative(realpathSync(process.cwd()), path);
    return fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd);
  } catch {
    return false;
  }
}

export type PreparedBrowserCommand = { args: string[] } | { error: string };

export function prepareBrowserCommand(input: string[]): PreparedBrowserCommand {
  const args: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index] ?? "";
    const flag = flagName(arg);
    if (STRIPPED.has(flag)) continue;
    if (STRIPPED_VALUE.has(flag)) {
      if (!arg.includes("=") && input[index + 1] === undefined) return { error: `${flag} needs a value.` };
      if (!arg.includes("=")) index += 1;
      continue;
    }
    args.push(arg);
  }

  for (const arg of args) {
    const flag = flagName(arg);
    if (OWNED.has(flag)) return { error: `webmesh manages ${flag}; drop it.` };
    const reason = BLOCKED.get(flag);
    if (reason) return { error: `${flag} is not available through webmesh: it would ${reason}.` };
  }

  for (let index = 0; index < args.length; index += 1) {
    const flag = flagName(args[index] ?? "");
    const value = flagValue(args, index);
    if ((flag === "-p" || flag === "--provider") && value !== "agentcore") {
      return { error: `${flag} is not available through webmesh for ${value ?? "an empty provider"}; only agentcore is supported.` };
    }
    if (flag === "--init-script" && !workspaceScript(value)) {
      return { error: "--init-script must name an existing JavaScript file inside the current workspace." };
    }
    if (flag === "--enable" && value !== "react-devtools") {
      return { error: `--enable is not available through webmesh for ${value ?? "an empty feature"}; only react-devtools is supported.` };
    }
  }

  const index = commandIndex(args);
  const command = index >= 0 ? args[index] : undefined;
  if (!command) {
    return { error: `Pass a browser command, not \`${args[0] ?? ""}\`. Run \`webmesh agent-browser --help\`.` };
  }
  const denied = DENIED_COMMANDS.get(command);
  if (denied) return { error: `webmesh agent-browser cannot ${denied}. Run \`webmesh agent-browser --help\`.` };
  const commandArgs = args.slice(index + 1);
  if (command === "connect") {
    const port = Number(commandArgs[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { error: "webmesh agent-browser connect accepts only a local debugging port." };
    }
  }
  if (command === "close" && commandArgs.includes("--all")) {
    return { error: "webmesh cannot close browser sessions owned by other agents; drop --all." };
  }
  return { args };
}

const POLICY = [
  "webmesh agent-browser <command>",
  "",
  "Webmesh keeps one browser session, restores saved logins, applies its proxy,",
  "and redacts secrets. Run one command at a time.",
  "",
  "The session is shared by every agent on this machine, and close ends it for",
  "all of them. Re-check the page before acting on it.",
  "Output stays redacted unless the user sets WEBMESH_REVEAL_SECRETS=1.",
  "",
  "Use absolute paths for files. Re-run snapshot -i after navigation, because element",
  `refs go stale. Long output is cut at ${MAX_FIELD} characters; ${CUT_HINT}.`,
];

// The command list is the engine's own, so it always matches the installed version. Lines that
// name something webmesh refuses are dropped rather than printed as a command nobody can run.
// agent-browser.json is dropped for the same reason --config is refused: it is read from the
// working directory with no flag, so printing where to put one advertises that door.
const REFUSED_FLAGS = [...BLOCKED.keys(), ...OWNED_FLAGS, ...STRIPPED_VALUE_FLAGS, "--all"];
const DENIED_HELP = new RegExp(`^\\s*(?:${[...DENIED_COMMANDS.keys()].join("|")})\\b`, "i");
const HELP_NOISE = /AGENT_BROWSER_|agent-browser\.json|\.agent-browser\/|Configuration:|config file|Plugin example|\{"headed"|skills path|SESSION=|(?:^|\s)-p(?:\s|,|$)/;
const keptHelpLine = (line: string): boolean =>
  !HELP_NOISE.test(line) && !DENIED_HELP.test(line) && !REFUSED_FLAGS.some((flag) => line.includes(flag));

// A section header whose body was filtered out is left dangling, so drop those too.
const HEADER = /^\S.*:$/;
const HIDDEN_HELP_SECTIONS = new Set(["Batch:", "Auth Vault:", "MCP:", "Command Chaining:", "iOS Simulator (requires Xcode and Appium):"]);
function dropHelpSections(lines: readonly string[]): string[] {
  let hidden = false;
  return lines.filter((line) => {
    if (HIDDEN_HELP_SECTIONS.has(line)) {
      hidden = true;
      return false;
    }
    if (hidden && HEADER.test(line)) hidden = false;
    return !hidden;
  });
}
const dropOrphanHeaders = (lines: readonly string[]): string[] =>
  lines.filter((line, index) => !(HEADER.test(line) && (lines[index + 1] ?? "").trim() === ""));

// Installer lines keep the real package name. Renaming them would print three commands that
// install nothing, which is worse than naming the engine.
const INSTALLER_LINE = /^\s*(?:npm|npx|yarn|pnpm|bun|brew|cargo|pip|pipx|apt|sudo)\b/;

/** Rename engine-facing text without inventing package-manager commands that do not exist. */
export function cleanEngineOutput(line: string): string {
  if (line.startsWith("allowed-tools:")) {
    const tools = line.slice("allowed-tools:".length).split(",").map((tool) => tool.trim());
    const adapted = tools.map((tool) => /^Bash\((?:npx )?agent-browser:\*\)$/.test(tool) ? "Bash(webmesh:*)" : tool);
    return `allowed-tools: ${[...new Set(adapted)].join(", ")}`;
  }
  if (INSTALLER_LINE.test(line)) return line;
  const protectedPackages = line.replace(/\b(npx|bunx|pnpm dlx|yarn dlx)\s+agent-browser\b/g, "$1 __agent_browser_package__");
  return cleanEngineStderr(protectedPackages)
    .replaceAll("__agent_browser_package__", "agent-browser")
    .replaceAll("skills get core", "skills get agent-browser")
    .replace("connect <port|url>", "connect <local-port>");
}

function insertSkillNote(content: string, note: string): string {
  const end = content.indexOf("\n---", 4);
  return end < 0 ? `${note}\n\n${content}` : `${content.slice(0, end + 4)}\n\n${note}${content.slice(end + 4)}`;
}

function dropMarkdownSection(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return content;
  const depth = heading.indexOf(" ");
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^#{2,${depth}} `).test(lines[end] ?? "")) end += 1;
  lines.splice(start, end - start);
  return lines.join("\n");
}

const SESSION_OPTION = /\s+--session(?:=(?:"[^"\n]*"|'[^'\n]*'|[^\s`]+)|\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s`]+))/g;
const SKILL_NOTE = "> Webmesh compatibility: run local browser commands exactly as written below. Webmesh owns the session, proxy, login state, and output redaction.";

/** Adapt bundled upstream skill prose while refusing to publish instructions the wrapper cannot run. */
export function adaptBrowserSkill(name: string, content: string): string {
  if (name === "core") return content;
  if (name === "vercel-sandbox") {
    return insertSkillNote(content, "> This skill runs agent-browser inside Vercel Sandbox. Its package names and sandbox commands intentionally remain upstream-native.");
  }

  let adapted = content.split("\n").map(cleanEngineOutput).join("\n");
  adapted = adapted
    .replace(/^export AGENT_BROWSER_SESSION=.*$/gm, "# Webmesh uses its shared session.")
    .replace(/AGENT_BROWSER_COLOR_SCHEME=\S+\s+/g, "")
    .replace(SESSION_OPTION, "");

  if (name === "agentcore") adapted = dropMarkdownSection(adapted, "## Using with AGENT_BROWSER_PROVIDER");
  if (name === "electron") {
    adapted = dropMarkdownSection(adapted, "### Run Multiple Apps Simultaneously")
      .replace("# Or use --cdp on each command", "# Connect once, then run commands normally")
      .replace("without needing `--cdp`", "without extra connection flags")
      .replace(
        "webmesh agent-browser --cdp 9222 snapshot -i",
        "webmesh agent-browser connect 9222\nwebmesh agent-browser snapshot -i",
      )
      .replace(
        "webmesh agent-browser --auto-connect snapshot -i",
        "# Connect with the app's local debugging port, then inspect it.\nwebmesh agent-browser connect 9222\nwebmesh agent-browser snapshot -i",
      )
      .replace(/\nOr set it globally:\n\n```bash\nwebmesh agent-browser connect 9222\n```/, "")
      .replace("automated with agent-browser.", "automated with webmesh agent-browser.");
  }
  if (name === "dogfood") {
    adapted = adapted
      .replace(
        /\| \*\*Session name\*\* \|[^\n]+/,
        "| **Browser session** | Shared webmesh session | Not configurable |",
      )
      .replace("Start a named session:", "Open the target in webmesh's shared session:")
      .replace(
        /```bash\ncp \{SKILL_DIR\}\/templates\/dogfood-report-template\.md \{OUTPUT_DIR\}\/report\.md\n```/,
        "Copy the `--- templates/dogfood-report-template.md ---` section from this full skill output to `{OUTPUT_DIR}/report.md`.",
      )
      .replace(
        /After successful login, save state for potential reuse:\n\n```bash\nwebmesh agent-browser state save \{OUTPUT_DIR\}\/auth-state\.json\n```/,
        "Webmesh keeps the authenticated session. Do not copy cookies into the report directory.",
      )
      .replace(
        /```bash\nwebmesh agent-browser close\n```/,
        "Leave the shared browser session open; webmesh manages its lifetime.",
      )
      .replace(
        /- \*\*Be efficient with commands\.\*\*[^\n]+/,
        "- **Run one browser command per shell call.** The shared session keeps state between commands.",
      );
  }

  for (const line of adapted.split("\n")) {
    if (!line.includes("webmesh agent-browser")) continue;
    const blocked = [...BLOCKED.keys(), ...OWNED, ...STRIPPED_VALUE].find((flag) => line.includes(flag));
    const denied = [...DENIED_COMMANDS.keys()].find((command) => line.includes(`webmesh agent-browser ${command}`));
    if (blocked || denied || line.includes("AGENT_BROWSER_")) {
      throw new Error(`The ${name} skill still requires unsupported browser syntax: ${line.trim()}`);
    }
  }

  return insertSkillNote(adapted, SKILL_NOTE);
}

async function engineHelp(bin: string): Promise<string[]> {
  const proc = Bun.spawn(engineArgs(bin, ["--help"]), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const cleaned = (stdout.trim() ? stdout : stderr).split("\n").map(cleanEngineOutput);
  return dropOrphanHeaders(dropHelpSections(cleaned).filter(keptHelpLine));
}

export async function browserUsage(bin: string): Promise<string> {
  const refused = [...DENIED_COMMANDS].map(([name, reason]) => `  - ${name}: ${reason}`);
  return [...POLICY, "", ...(await engineHelp(bin)), "", "webmesh refuses", "", ...refused].join("\n");
}

export async function browserReference(bin: string): Promise<string> {
  const lines = [await browserUsage(bin), "", "Flags webmesh refuses", ""];
  for (const [reason, flags] of Object.entries(BLOCKED_FLAGS)) {
    lines.push(`  ${reason}`, `    ${flags.join(", ")}`);
  }
  lines.push(
    "",
    `Flags webmesh sets itself, so do not pass them: ${OWNED_FLAGS.join(", ")}`,
    `Flags webmesh accepts and drops: ${[...STRIPPED_FLAGS, ...STRIPPED_VALUE_FLAGS].join(", ")}`,
    "Restricted support: connect accepts a local port; provider accepts agentcore; --init-script accepts workspace JavaScript; --enable accepts react-devtools.",
    "",
    "Every other bundled flag passes through unchanged.",
  );
  return lines.join("\n");
}

// `pass` and `auth` only as whole words: "passes: 12" (axe) and "author: Ada" are not secrets.
const SECRET_KEY = /passw(?:or)?d|pass(?![a-z])|secret|token|authorization|cookie|api[-_]?key|jwt|credential|bearer/i;
const SECRET_PARAM = /([?&#](?:access_token|id_token|refresh_token|token|api_key|apikey|key|secret|client_secret|password|sig|signature)=)[^&#\s"']+/gi;
const SECRET_ASSIGNMENT = /(\b[\w.-]*(?:session|auth(?!or)|token|cookie|secret|passw(?:or)?d|pass(?![a-z])|api[-_]?key|jwt|credential)[\w.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;,}&#]+)/gi;
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
    const dir = join(dirname(Bun.resolveSync("agent-browser/package.json", import.meta.dir)), "bin");
    launcher = nativeLauncher(dir) ?? join(dir, "agent-browser.js");
  } catch {
    launcher = null;
  }
  return launcher;
}

const JS_SCRIPT = /\.(?:js|mjs|cjs)$/;

function browserConfigPath(): string {
  const paths = [join(import.meta.dir, "..", "webmesh-agent-browser-config.json"), join(import.meta.dir, "webmesh-agent-browser-config.json")];
  const path = paths.find(existsSync);
  if (!path) throw new Error("The bundled Webmesh agent-browser config is missing.");
  return path;
}

export function engineArgs(bin: string, args: string[]): string[] {
  const managed = ["--config", browserConfigPath(), ...args];
  return JS_SCRIPT.test(bin) ? [process.execPath, bin, ...managed] : [bin, ...managed];
}

function nativeLauncher(dir: string): string | undefined {
  const musl = process.platform === "linux" && (existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1"));
  const os = musl ? "linux-musl" : process.platform;
  const path = join(dir, `agent-browser-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

let systemBrowser: boolean | undefined;

function hasSystemBrowser(): boolean {
  return (systemBrowser ??= detectSystemBrowser());
}

function detectSystemBrowser(): boolean {
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

// MCP uses stdout for its protocol, so install progress goes to stderr and the
// child's own output is captured instead of inherited.
export function ensureBrowser(bin: string): Promise<string | undefined> {
  if (hasSystemBrowser()) return Promise.resolve(undefined);
  return (browserInstall ??= (async () => {
    process.stderr.write("webmesh: downloading Chromium for browser commands (first use only)...\n");
    const proc = Bun.spawn(engineArgs(bin, ["install"]), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) return undefined;
    browserInstall = undefined; // a failed download must not be cached for the life of the process
    const detail = cleanEngineOutput((stderr || stdout).trim().split("\n")[0] ?? "");
    return detail ? `Could not install Chromium: ${detail}. ${CHROME_FIX}` : `Could not install Chromium. ${CHROME_FIX}`;
  })());
}

const ENGINE_BRAND = "[agent-browser] ";
const BROWSER_BRAND = "[webmesh agent-browser] ";
const BANNER = /^\[webmesh agent-browser\] (?:(?:launched|relaunched|reused|closed) browser\b|(?:restore|save): )/;
const ENGINE_NAME = /(?<![\w./-])agent-browser(?![\w/-]|\.[A-Za-z0-9])/g;

export function cleanEngineStderr(line: string): string {
  if (line.startsWith(ENGINE_BRAND)) return `${BROWSER_BRAND}${line.slice(ENGINE_BRAND.length)}`;
  return line.replace(ENGINE_NAME, "webmesh agent-browser");
}

export function killTree(proc: Bun.Subprocess<"ignore", "inherit", "pipe"> | Bun.Subprocess<"ignore", "pipe", "pipe">): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill();
  }
}

function hint(error: string): string {
  if (/unknown ref|ref not found|element not found/i.test(error)) {
    return `${error}. Refs change when the page changes; run snapshot -i again.`;
  }
  if (/failed to launch chrome|chrome not found|no chrome/i.test(error)) {
    return `${error}. The Chromium webmesh installed could not start. ${CHROME_FIX}`;
  }
  if (/covered by/i.test(error)) {
    return `${error}. Something is over the element; snapshot -i, dismiss it, then click again.`;
  }
  if (/ffmpeg/i.test(error)) {
    return `${error}. Video recording needs ffmpeg with the libvpx and libx264 encoders.`;
  }
  if (/strict mode violation|resolved to \d+ elements|multiple elements/i.test(error)) {
    return `${error}. More than one element matched; use a snapshot -i ref, or find a narrower locator.`;
  }
  if (/net::err|err_connection|err_name_not_resolved|navigation (?:failed|timeout)/i.test(error)) {
    return `${error}. The page did not load; check the URL, or the site may need webmesh login.`;
  }
  if (/cross-origin iframe|not accessible/i.test(error)) {
    return `${error}. Cross-origin frames are skipped; use frame, or eval in that origin.`;
  }
  return error;
}

type JsonValue = BrowserData[string];

function redactText(text: string): string {
  const assigned = text.replace(SECRET_PARAM, `$1${REDACTED}`).replace(SECRET_ASSIGNMENT, `$1${REDACTED}`);
  return SECRET_VALUES.reduce((out, pattern) => out.replace(pattern, REDACTED), assigned);
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
  const { lifecycle, ...rest } = data;
  const restored = z.object({ restoreStatus: z.string() }).safeParse(lifecycle);
  if (restored.success && restored.data.restoreStatus !== "not_configured") rest.restoreStatus = restored.data.restoreStatus;
  if (Object.hasOwn(rest, "snapshot")) delete rest.refs;
  for (const [key, value] of Object.entries(rest)) {
    const text = z.string().min(MAX_FIELD + 1).safeParse(value);
    if (text.success) rest[key] = `${text.data.slice(0, MAX_FIELD)}\n… cut at ${MAX_FIELD} characters; ${CUT_HINT}`;
  }
  return rest;
}

// A line that only looks like JSON (a log line starting with "{") falls through to the text path.
function jsonLine(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function parseOutput(stdout: string, stderr: string, exitCode: number): BrowserResult {
  const line = stdout.trim().split("\n").findLast((candidate) => candidate.startsWith("{"));
  const parsed = line ? output.safeParse(jsonLine(line)) : undefined;
  if (parsed?.success) {
    if (!parsed.data.success) return { success: false, error: hint(cleanEngineOutput(parsed.data.error ?? "The browser command failed.")) };
    return { success: true, data: trim(parsed.data.data ?? {}) };
  }
  if (exitCode === 0 && stdout.trim()) return { success: true, data: trim({ output: cleanEngineOutput(stdout.trim()) }) };
  const lines = (stderr || stdout)
    .split("\n")
    .map(cleanEngineStderr)
    .filter((line) => line.trim() !== "");
  const detail = lines.find((line) => !BANNER.test(line)) ?? lines[0];
  return { success: false, error: hint(detail ?? `Webmesh agent-browser exited with ${exitCode}`) };
}

export function savedLoginHosts(states: string[]): string[] | undefined {
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
  return [...hosts].sort();
}

export function bypassFor(states: string[]): string[] | undefined {
  return savedLoginHosts(states)?.flatMap((host) => [host, `*.${host}`]);
}

async function savedLoginStates(bin: string): Promise<string[] | undefined> {
  try {
    const proc = Bun.spawn(engineArgs(bin, ["--json", "state", "list"]), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const listed = parseOutput(await new Response(proc.stdout).text(), "", await proc.exited);
    const dir = z.object({ directory: z.string() }).safeParse(listed.success ? listed.data : null);
    if (!dir.success) return undefined;
    const files = readdirSync(dir.data.directory).filter((file) => file.startsWith(`${LOGIN_STATE}-`) && file.endsWith(".json"));
    return files.map((file) => readFileSync(join(dir.data.directory, file), "utf8"));
  } catch {
    return undefined;
  }
}

export async function loginBypass(bin: string): Promise<string[] | undefined> {
  const states = await savedLoginStates(bin);
  return states && bypassFor(states);
}

export async function loginHosts(bin: string): Promise<string[] | undefined> {
  const states = await savedLoginStates(bin);
  return states && savedLoginHosts(states);
}

export type Launch = { flags: string[]; env: { AGENT_BROWSER_PROXY?: string; AGENT_BROWSER_PROXY_BYPASS?: string } };

// Sites you logged into always go direct: a login used from a proxy IP gets challenged or locked.
// The proxy travels in the environment because it may carry a password, and argv is readable by
// every local user.
export async function launchFlags(bin: string, { restore, proxy }: { restore?: string; proxy?: string }): Promise<Launch> {
  const flags = restore ? ["--restore", restore, "--restore-save", "never"] : [];
  if (!proxy) return { flags, env: {} };
  const bypass = restore ? await loginBypass(bin) : [];
  if (bypass === undefined) return { flags, env: {} };
  const env: Launch["env"] = { AGENT_BROWSER_PROXY: proxy };
  if (bypass.length > 0) env.AGENT_BROWSER_PROXY_BYPASS = bypass.join(",");
  return { flags, env };
}

// Chrome never sends loopback traffic to a proxy unless the bypass list subtracts it, so without
// `<-loopback>` a page could still reach 127.0.0.1 and localhost around the filter.
export const filteredEnv = (filterUrl: string): Launch["env"] => ({
  AGENT_BROWSER_PROXY: filterUrl,
  AGENT_BROWSER_PROXY_BYPASS: "<-loopback>",
});

// The engine reads AGENT_BROWSER_* env vars as twins of the flags webmesh refuses, so filtering
// argv alone leaves the same doors open: _SESSION retargets the session, _STATE reattaches login
// state, _EXECUTABLE_PATH runs another binary.
const ENGINE_ENV = /^AGENT_BROWSER_/i;

export function browserEnv(proxy: string | undefined): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !ENGINE_ENV.test(name) && !(proxy !== undefined && PROXY_ENV.test(name))),
  );
}

type BrowserOptions = {
  restore?: string;
  redact?: boolean;
  proxy?: string;
  allowPrivateNetworks?: boolean;
  allowPrivateHosts?: readonly string[];
  resolve?: ResolveAddresses;
};

export function createBrowser(
  session: string,
  { restore, redact: hide = false, proxy, allowPrivateNetworks = false, allowPrivateHosts = [], resolve }: BrowserOptions = {},
) {
  let used = false;
  let closed = false;
  let launch: Promise<Launch> | undefined;
  let network: Awaited<ReturnType<typeof startNetworkProxy>> | undefined;
  let queue: Promise<BrowserResult | undefined> = Promise.resolve(undefined);

  // One page, one command at a time: parallel tool calls would race each other.
  function run(args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    const next = queue.then(() => execute(args, signal));
    queue = next.catch(() => undefined);
    return next;
  }

  async function startLaunch(bin: string): Promise<Launch> {
    if (allowPrivateNetworks) return launchFlags(bin, { restore, proxy });
    const directHosts = restore ? (await loginBypass(bin)) ?? [] : [];
    network ??= await startNetworkProxy({ upstreamProxy: proxy, directHosts, allowedHosts: allowPrivateHosts, resolve });
    return { flags: (await launchFlags(bin, { restore })).flags, env: filteredEnv(network.url) };
  }

  // A failed start is not remembered, so the next command tries again instead of failing forever.
  function launchOnce(bin: string): Promise<Launch> {
    launch ??= startLaunch(bin).catch((error) => {
      launch = undefined;
      throw error;
    });
    return launch;
  }

  async function execute(args: string[], signal?: AbortSignal): Promise<BrowserResult> {
    const prepared = prepareBrowserCommand(args);
    if ("error" in prepared) return { success: false, error: prepared.error };
    args = prepared.args;
    const command = browserCommandName(args);
    const bin = agentBrowserPath();
    if (!bin) return { success: false, error: "Webmesh agent-browser support is not installed." };
    // Only this command drives someone else's browser; the next plain command launches ours, filtered.
    const external = command === "connect" || browserProvider(args) !== undefined;
    if (command !== "close" && !external) {
      const installError = await ensureBrowser(bin);
      if (installError) return { success: false, error: installError };
    }
    if (!allowPrivateNetworks) {
      for (const arg of args) {
        if (!/^https?:\/\//i.test(arg)) continue;
        const error = await blockedUrl(arg, resolve, allowPrivateHosts);
        if (error) return { success: false, error };
      }
    }
    let launched: Launch = { flags: [], env: {} };
    if (!external) {
      try {
        launched = await launchOnce(bin);
      } catch (error) {
        return { success: false, error: `Could not start the browser network filter: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    used = true;
    const proc = Bun.spawn(engineArgs(bin, ["--json", "--session", session, ...launched.flags, ...args]), {
      env: { ...browserEnv(proxy), ...launched.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const kill = () => killTree(proc);
    const timer = setTimeout(kill, TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (signal?.aborted) return { success: false, error: "cancelled" };
      if (proc.signalCode) return { success: false, error: `Webmesh agent-browser timed out after ${TIMEOUT_MS / 1000}s` };
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
      await network?.close();
    }
  }

  return { session, run, close };
}
export { ensureBrowserFilter, FILTER_ENV, serveBrowserFilter, stopBrowserFilter, type FilterConfig } from "./browserFilter";
