import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySkill, editServers } from "../src/setup";

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

test("installs, updates, and removes the project skill", () => {
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
