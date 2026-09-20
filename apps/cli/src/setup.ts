import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { keyNames, loadSettings, maskProxy, proxyUrl, saveSettings, settingsPath, fetchers } from "@webmesh/core";
import { z } from "zod";

const NAME = "webmesh";
const SKILL = join(".agents", "skills", NAME, "SKILL.md");
const config = z.record(z.string(), z.json());
type Entry = z.infer<typeof config>[string];

export type Outcome = "added" | "updated" | "already set" | "removed" | "not set" | `skipped: ${string}` | `failed: ${string}`;

function bundledSkill(): string {
  const paths = [join(import.meta.dir, "..", "..", "..", "skills", NAME, "SKILL.md"), join(import.meta.dir, "skills", NAME, "SKILL.md")];
  const path = paths.find(existsSync);
  if (!path) throw new Error("The bundled Webmesh skill is missing.");
  return readFileSync(path, "utf8");
}

export function applySkill(root: string, remove: boolean, content = bundledSkill()): Outcome {
  const path = join(root, SKILL);
  if (remove) {
    if (!existsSync(path)) return "not set";
    unlinkSync(path);
    if (readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path));
    return "removed";
  }
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (before === content) return "already set";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return before === undefined ? "added" : "updated";
}

export function editServers(text: string, section: string, entry: Entry | undefined): { text: string; outcome: Outcome } | undefined {
  let parsed;
  try {
    parsed = config.safeParse(JSON.parse(text.trim() || "{}"));
  } catch {
    return undefined;
  }
  const servers = parsed.success ? config.safeParse(parsed.data[section] ?? {}) : undefined;
  if (!parsed.success || !servers?.success) return undefined;
  const current = servers.data[NAME];
  const next = { ...servers.data };
  if (entry === undefined) {
    if (current === undefined) return { text, outcome: "not set" };
    delete next[NAME];
  } else {
    if (JSON.stringify(current) === JSON.stringify(entry)) return { text, outcome: "already set" };
    next[NAME] = entry;
  }
  const outcome = entry === undefined ? "removed" : current === undefined ? "added" : "updated";
  return { text: `${JSON.stringify({ ...parsed.data, [section]: next }, null, 2)}\n`, outcome };
}

type Agent = { name: string; found: () => boolean; apply: (remove: boolean) => Promise<Outcome> };

function fileAgent(name: string, path: string, section: string, entry: Entry): Agent {
  return {
    name,
    found: () => existsSync(dirname(path)),
    async apply(remove) {
      const before = existsSync(path) ? readFileSync(path, "utf8") : "";
      const change = editServers(before, section, remove ? undefined : entry);
      if (!change) return `skipped: ${path} isn't plain JSON, add webmesh by hand`;
      if (change.text !== before) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, change.text);
      }
      return change.outcome;
    },
  };
}

async function exec(cmd: string[]): Promise<{ ok: boolean; message: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, message: (stderr || stdout).trim().split("\n")[0] ?? "" };
}

function cliAgent(name: string, bin: string, add: string[], remove: string[]): Agent {
  return {
    name,
    found: () => Bun.which(bin) !== null,
    async apply(removing) {
      const present = (await exec([bin, "mcp", "get", NAME])).ok;
      if (removing && !present) return "not set";
      if (!removing && present) return "already set";
      const result = await exec([bin, ...(removing ? remove : add)]);
      if (!result.ok) return `failed: ${result.message}`;
      return removing ? "removed" : "added";
    },
  };
}

const home = homedir();
const stdio = { command: "webmesh", args: ["mcp"] };

export const agents = [
  cliAgent("claude-code", "claude", ["mcp", "add", "-s", "user", NAME, "--", "webmesh", "mcp"], ["mcp", "remove", "-s", "user", NAME]),
  cliAgent("codex", "codex", ["mcp", "add", NAME, "--", "webmesh", "mcp"], ["mcp", "remove", NAME]),
  fileAgent("cursor", join(home, ".cursor", "mcp.json"), "mcpServers", stdio),
  fileAgent("pi", join(home, ".pi", "agent", "mcp.json"), "mcpServers", stdio),
  fileAgent("opencode", join(home, ".config", "opencode", "opencode.json"), "mcp", {
    type: "local",
    command: ["webmesh", "mcp"],
    enabled: true,
  }),
];

export async function setup(only: string | undefined, remove: boolean): Promise<string[]> {
  const chosen = only ? agents.filter((agent) => agent.name === only) : agents;
  if (only && chosen.length === 0) return [`Unknown agent ${only}. Use one of: ${agents.map((agent) => agent.name).join(", ")}.`];
  const lines: string[] = [];
  for (const agent of chosen) {
    lines.push(`${agent.name.padEnd(12)} ${agent.found() ? await agent.apply(remove) : "not found"}`);
  }
  if (!remove || !only) {
    lines.push(`${"agent skill".padEnd(12)} ${applySkill(process.cwd(), remove)}`);
  }
  if (!remove && Bun.which("webmesh") === null) {
    lines.push("", "webmesh isn't on your PATH, so agents can't start it. Install it with: npm install -g webmesh.js");
  }
  if (!remove && !(fetchers["yt-dlp"].available?.() ?? false)) {
    lines.push(
      "",
      "YouTube and social fetch is off: no yt-dlp found. Install it with: brew install yt-dlp, pipx install yt-dlp, or drop a binary at packages/core/bin/yt-dlp",
    );
  }
  if (!remove) lines.push("", "Restart your agents to load webmesh.");
  return lines;
}

export type SetupResult = { ok: boolean; lines: string[] };

export function setProxy(url: string | undefined, remove: boolean): SetupResult {
  const settings = loadSettings();
  if (remove) {
    delete settings.proxy;
    saveSettings(settings);
    return { ok: true, lines: ["Proxy removed. Everything goes direct."] };
  }
  const parsed = proxyUrl.safeParse(url);
  if (!parsed.success) return { ok: false, lines: ["Usage: webmesh setup proxy http://user:pass@host:port"] };
  settings.proxy = parsed.data;
  saveSettings(settings);
  return {
    ok: true,
    lines: [
      `Proxy saved: ${maskProxy(parsed.data)}`,
      "Scrapers, local fetches, and anonymous browsing go through it.",
      "Sites you logged into with webmesh login, paid APIs, and free API endpoints stay direct.",
    ],
  };
}

export async function setKey(name: string | undefined, value: string | undefined, remove: boolean): Promise<SetupResult> {
  const known = keyNames();
  if (!name || !known.includes(name)) return { ok: false, lines: [`Use one of: ${known.join(", ")}.`] };
  const settings = loadSettings();
  if (remove) {
    delete settings.keys[name];
    saveSettings(settings);
    return { ok: true, lines: [`${name} removed.`] };
  }
  let key = value;
  if (!key) {
    console.log(`Paste ${name} and press Enter:`);
    for await (const line of console) {
      key = line.trim();
      break;
    }
  }
  if (!key) return { ok: false, lines: ["No key given."] };
  settings.keys[name] = key;
  saveSettings(settings);
  return { ok: true, lines: [`${name} saved to ${settingsPath()}. Restart your agents to use it.`] };
}
