import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const NAME = "webmesh";
const config = z.record(z.string(), z.json());
type Entry = z.infer<typeof config>[string];

export type Outcome = "added" | "updated" | "already set" | "removed" | "not set" | `skipped: ${string}` | `failed: ${string}`;

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
  if (!remove && Bun.which("webmesh") === null) {
    lines.push("", "webmesh isn't on your PATH, so agents can't start it. Install it with: bun add -g @webmesh/cli");
  }
  if (!remove) lines.push("", "Restart your agents to load webmesh.");
  return lines;
}
