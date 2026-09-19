import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/state";

test("sessions sharing one store file see each other's cooldowns, health, and cached results", () => {
  const path = join(mkdtempSync(join(tmpdir(), "webmesh-")), "webmesh.db");
  const first = openStore(path);
  const second = openStore(path);

  first.bench("ddg", 5_000);
  second.bench("ddg", 2_000);
  first.observe("brave", { success: 0 });
  second.observe("brave", { success: 0 });
  first.write("q", { success: true, provider: "brave", attempts: [], data: [{ title: "t", url: "https://t.com", description: "" }] }, 100);

  const state = second.load();
  expect(state.benched.ddg).toBe(5_000);
  expect(state.health.brave?.success).toBeCloseTo(0.49);
  expect(second.read("q", 99)?.provider).toBe("brave");
  expect(second.read("q", 100)).toBeUndefined();
});
