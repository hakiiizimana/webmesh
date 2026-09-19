import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCache, openStore } from "../src/state";
import type { SuccessfulSearch } from "../src/types";

const result: SuccessfulSearch = {
  success: true as const,
  data: [{ title: "t", url: "https://t.com", description: "" }],
};

test("sessions sharing one store file see each other's cooldowns, health, and cached results", () => {
  const path = join(mkdtempSync(join(tmpdir(), "webmesh-")), "webmesh.db");
  const first = openStore(path);
  const second = openStore(path);

  first.bench("ddg", 5_000);
  second.bench("ddg", 2_000);
  first.observe("brave", { success: 0 });
  second.observe("brave", { success: 0 });
  first.write("q", result, 100);

  const state = second.load();
  expect(state.benched.ddg).toBe(5_000);
  expect(state.health.brave?.success).toBeCloseTo(0.49);
  expect(second.read("q", 99)).toEqual(result);
  expect(second.read("q", 100)).toBeUndefined();
});

test("memory and disk caches store the clean successful response shape", () => {
  const dirty = {
    ...result,
    cachedAt: 1,
    data: [{ title: "t", url: "https://t.com", description: "", extra: true }],
  };
  const memory = memoryCache();
  memory.write("q", dirty, 100);
  expect(memory.read("q", 0)).toEqual(result);

  const store = openStore(join(mkdtempSync(join(tmpdir(), "webmesh-")), "webmesh.db"));
  store.write("q", dirty, 100);
  expect(store.read("q", 0)).toEqual(result);
});

test("disk cache rejects and removes incompatible legacy rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "webmesh-")), "webmesh.db");
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, result TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  db.query("INSERT INTO cache (key, result, expires_at) VALUES (?, ?, ?)").run("old", JSON.stringify({ success: true }), 100);
  db.query("INSERT INTO cache (key, result, expires_at) VALUES (?, ?, ?)").run("broken", "not-json", 100);
  db.close();

  const store = openStore(path);
  expect(store.read("old", 0)).toBeUndefined();
  expect(store.read("broken", 0)).toBeUndefined();

  const check = new Database(path, { create: true });
  expect(check.query("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
  check.close();
});
