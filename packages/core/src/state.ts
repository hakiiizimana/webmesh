import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";

export type ProviderHealth = { success: number; latencyMs: number };
export type RoutingState = { benched: Record<string, number>; health: Record<string, ProviderHealth> };

export type StateStore = {
  load: () => RoutingState;
  observe: (id: string, sample: Partial<ProviderHealth>) => void;
  bench: (id: string, until: number) => void;
};

export type CacheStore = {
  read: <T>(key: string, schema: ZodType<T>, now: number) => T | undefined;
  write: <T>(key: string, result: T, expiresAt: number) => void;
};

const HEALTH_ALPHA = 0.3;
export const NEW_PROVIDER: ProviderHealth = { success: 1, latencyMs: 1_500 };
const DISK_CACHE_MAX_ENTRIES = 1_000;

const blend = (average: number, sample: number) => average + HEALTH_ALPHA * (sample - average);

function nextHealth(current: ProviderHealth | undefined, sample: Partial<ProviderHealth>): ProviderHealth {
  const base = current ?? NEW_PROVIDER;
  return {
    success: sample.success === undefined ? base.success : blend(base.success, sample.success),
    latencyMs: sample.latencyMs === undefined ? base.latencyMs : blend(base.latencyMs, sample.latencyMs),
  };
}

const defaultPath = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "webmesh", "webmesh.db");

type ProviderRow = { id: string; benched_until: number; success: number | null; latency_ms: number | null };

export function openStore(path = defaultPath()): StateStore & CacheStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      benched_until INTEGER NOT NULL DEFAULT 0,
      success REAL,
      latency_ms REAL
    );
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const allProviders = db.query<ProviderRow, []>("SELECT id, benched_until, success, latency_ms FROM providers");
  const oneProvider = db.query<ProviderRow, [string]>(
    "SELECT id, benched_until, success, latency_ms FROM providers WHERE id = ?",
  );
  const saveHealth = db.query<void, [string, number, number]>(
    `INSERT INTO providers (id, success, latency_ms) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET success = excluded.success, latency_ms = excluded.latency_ms`,
  );
  const saveBench = db.query<void, [string, number]>(
    `INSERT INTO providers (id, benched_until) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET benched_until = max(benched_until, excluded.benched_until)`,
  );
  const readCache = db.query<{ result: string; expires_at: number }, [string]>(
    "SELECT result, expires_at FROM cache WHERE key = ?",
  );
  const writeCache = db.query<void, [string, string, number]>(
    "INSERT OR REPLACE INTO cache (key, result, expires_at) VALUES (?, ?, ?)",
  );
  const deleteCache = db.query<void, [string]>("DELETE FROM cache WHERE key = ?");
  const pruneCache = db.query<void, [number]>(
    "DELETE FROM cache WHERE key NOT IN (SELECT key FROM cache ORDER BY expires_at DESC LIMIT ?)",
  );

  const health = (row: ProviderRow | null): ProviderHealth | undefined =>
    row?.success != null && row.latency_ms != null ? { success: row.success, latencyMs: row.latency_ms } : undefined;

  // Under a write lock, so two sessions observing one provider both count.
  const observe = db.transaction((id: string, sample: Partial<ProviderHealth>) => {
    const next = nextHealth(health(oneProvider.get(id)), sample);
    saveHealth.run(id, next.success, next.latencyMs);
  });

  return {
    load() {
      const state: RoutingState = { benched: {}, health: {} };
      for (const row of allProviders.all()) {
        state.benched[row.id] = row.benched_until;
        const known = health(row);
        if (known) state.health[row.id] = known;
      }
      return state;
    },
    observe: (id, sample) => observe.immediate(id, sample),
    bench: (id, until) => saveBench.run(id, until),
    read(key, schema, now) {
      const row = readCache.get(key);
      if (!row || row.expires_at <= now) return undefined;
      try {
        const parsed = schema.safeParse(JSON.parse(row.result));
        if (parsed.success) return parsed.data;
      } catch {
        deleteCache.run(key);
        return undefined;
      }
      deleteCache.run(key);
      return undefined;
    },
    write(key, result, expiresAt) {
      writeCache.run(key, JSON.stringify(result), expiresAt);
      pruneCache.run(DISK_CACHE_MAX_ENTRIES);
    },
  };
}

export function memoryStore(): StateStore {
  const state: RoutingState = { benched: {}, health: {} };
  return {
    load: () => structuredClone(state),
    observe: (id, sample) => {
      state.health[id] = nextHealth(state.health[id], sample);
    },
    bench: (id, until) => {
      state.benched[id] = Math.max(state.benched[id] ?? 0, until);
    },
  };
}

export function memoryCache(maxEntries = 128): CacheStore {
  const entries = new Map<string, { result: unknown; expiresAt: number }>();
  return {
    read(key, schema, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= now) return undefined;
      entries.set(key, entry);
      const parsed = schema.safeParse(structuredClone(entry.result));
      return parsed.success ? parsed.data : undefined;
    },
    write(key, result, expiresAt) {
      entries.delete(key);
      entries.set(key, { result: structuredClone(result), expiresAt });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
