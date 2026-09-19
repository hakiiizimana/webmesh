import { expect, test } from "bun:test";
import { editServers } from "../src/setup";

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
