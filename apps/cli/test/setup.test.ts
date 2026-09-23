import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowHost, applySkill, editServers } from "../src/setup";

const entry = { command: "webmesh", args: ["mcp"] };

test("adds webmesh next to existing servers and leaves them alone", () => {
  const before = JSON.stringify({ theme: "dark", mcpServers: { railway: { command: "railway", args: ["mcp"] } } });
  const change = editServers(before, "mcpServers", entry);

  expect(change?.outcome).toBe("added");
  expect(JSON.parse(change?.text ?? "")).toEqual({
    theme: "dark",
    mcpServers: { railway: { command: "railway", args: ["mcp"] }, webmesh: entry },
  });
});

test("does not rewrite a file that is already right, and removes cleanly", () => {
  const set = JSON.stringify({ mcpServers: { webmesh: entry } });

  expect(editServers(set, "mcpServers", entry)).toEqual({ text: set, outcome: "already set" });
  expect(JSON.parse(editServers(set, "mcpServers", undefined)?.text ?? "")).toEqual({ mcpServers: {} });
  expect(editServers("", "mcpServers", undefined)?.outcome).toBe("not set");
});

test("refuses files that are not plain JSON instead of overwriting them", () => {
  expect(editServers('{ // comment\n "mcp": {} }', "mcp", entry)).toBeUndefined();
});

test("installs, updates, and removes a project skill", () => {
  const root = mkdtempSync(join(tmpdir(), "webmesh-setup-"));
  const path = join(root, ".agents", "skills", "webmesh", "SKILL.md");

  expect(applySkill(root, false, "webmesh", "first")).toBe("added");
  expect(applySkill(root, false, "webmesh", "first")).toBe("already set");
  expect(applySkill(root, false, "webmesh", "second")).toBe("updated");
  expect(readFileSync(path, "utf8")).toBe("second");
  writeFileSync(join(root, ".agents", "skills", "webmesh", "notes.md"), "keep");
  expect(applySkill(root, true, "webmesh")).toBe("removed");
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(root, ".agents", "skills", "webmesh", "notes.md"))).toBe(true);
  expect(applySkill(root, true, "webmesh")).toBe("not set");
});

test("keeps two skills in their own directories", () => {
  const root = mkdtempSync(join(tmpdir(), "webmesh-setup-"));
  const read = join(root, ".agents", "skills", "webmesh", "SKILL.md");
  const browser = join(root, ".agents", "skills", "agent-browser", "SKILL.md");

  expect(applySkill(root, false, "webmesh", "read")).toBe("added");
  expect(applySkill(root, false, "agent-browser", "browser page")).toBe("added");
  expect(readFileSync(read, "utf8")).toBe("read");
  expect(readFileSync(browser, "utf8")).toBe("browser page");

  expect(applySkill(root, true, "agent-browser")).toBe("removed");
  expect(existsSync(read)).toBe(true);
  expect(existsSync(browser)).toBe(false);
});

test("ships a bundled skill for every name setup installs", () => {
  const root = mkdtempSync(join(tmpdir(), "webmesh-setup-"));
  for (const name of ["webmesh", "agent-browser"]) {
    expect(applySkill(root, false, name)).toBe("added");
  }
});

test("allows one private host:port, and removes it again", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "webmesh-config-"));
  const saved = () => JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME ?? "", "webmesh", "config.json"), "utf8"));
  try {
    expect(allowHost("localhost", false).ok).toBe(false);
    expect(allowHost("localhost:3000", false).ok).toBe(true);
    expect(allowHost("LOCALHOST:3000", false).ok).toBe(true);
    expect(saved().allowPrivateHosts).toEqual(["localhost:3000"]);

    expect(allowHost("localhost:3000", true).lines[0]).toContain("blocked again");
    expect(saved().allowPrivateHosts).toEqual([]);
  } finally {
    process.env.XDG_CONFIG_HOME = previous;
  }
});
