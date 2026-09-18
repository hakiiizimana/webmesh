import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const rotationState = z.object({
  last: z.string().optional(),
  benched: z.record(z.string(), z.number()).default({}),
});

export type RotationState = z.infer<typeof rotationState>;

export type StateStore = {
  load: () => RotationState;
  save: (state: RotationState) => void;
};

const defaultPath = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "webmesh", "state.json");

export function fileStore(path = defaultPath()): StateStore {
  return {
    load() {
      try {
        return rotationState.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return { benched: {} };
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state));
    },
  };
}

export function memoryStore(): StateStore {
  let state: RotationState = { benched: {} };
  return {
    load: () => structuredClone(state),
    save: (next) => {
      state = structuredClone(next);
    },
  };
}
