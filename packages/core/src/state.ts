import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Moving averages per provider: share of searches that returned results, and time to answer. */
const health = z.object({ success: z.number(), latencyMs: z.number() });

const routingState = z.object({
  benched: z.record(z.string(), z.number()).default({}),
  health: z.record(z.string(), health).default({}),
});

export type ProviderHealth = z.infer<typeof health>;
export type RoutingState = z.infer<typeof routingState>;

export type StateStore = {
  load: () => RoutingState;
  save: (state: RoutingState) => void;
};

const defaultPath = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "webmesh", "state.json");

export function fileStore(path = defaultPath()): StateStore {
  return {
    load() {
      try {
        return routingState.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return { benched: {}, health: {} };
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state));
    },
  };
}

export function memoryStore(): StateStore {
  let state: RoutingState = { benched: {}, health: {} };
  return {
    load: () => structuredClone(state),
    save: (next) => {
      state = structuredClone(next);
    },
  };
}
