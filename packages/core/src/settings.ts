import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const proxyUrl = z.url({ protocol: /^https?$/ });

const settingsSchema = z.object({
  keys: z.record(z.string(), z.string()).default({}),
  proxy: proxyUrl.optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export const settingsPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "webmesh", "config.json");

export function loadSettings(path = settingsPath()): Settings {
  if (!existsSync(path)) return { keys: {} };
  const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}`);
  return parsed.data;
}

export function saveSettings(settings: Settings, path = settingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function mergeEnv(keys: Settings["keys"], env: Record<string, string | undefined>) {
  const set = Object.entries(env).filter(([, value]) => value !== undefined && value !== "");
  return { ...keys, ...Object.fromEntries(set) };
}

export function maskProxy(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed?.password) return url;
  parsed.password = "***";
  return parsed.href;
}
