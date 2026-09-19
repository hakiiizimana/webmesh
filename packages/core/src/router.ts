import { SoftBlockError } from "./html";
import { HttpError, NetworkError } from "./http";
import { NEW_PROVIDER, type ProviderHealth, type RoutingState, type StateStore } from "./state";
import type { ProviderKind } from "./types";

const BLOCKED_MS = 10 * 60_000;
const TRANSIENT_MS = 30_000;
const RETRY_DELAY_MS = 400;

/** The provider worked, but the page it was asked for failed (404, 403, ...). No cooldown, no health penalty. */
export class TargetError extends Error {}

/** What the router needs from a provider: how it's tiered and whether it needs a key. */
export type Routable = { kind: ProviderKind; env?: string };

export type RouterOptions = {
  store: StateStore;
  env?: Record<string, string | undefined>;
  /** Total time one call may take across every provider it tries. */
  budgetMs?: number;
  /** How long a provider may run before the next one starts alongside it. */
  hedgeMs?: number;
  /** Base pause before the single retry on a network error or 5xx; jittered up to double. */
  retryDelayMs?: number;
  now?: () => number;
  random?: () => number;
};

/** `provider` answered; `attempts` says what happened to each provider tried or skipped before it. */
export type Routed<T> = { success: true; provider: string; attempts: string[]; data: T } | { success: false; error: string };

/** One routed call: what to ask each provider, and which answers count. `empty` names a rejected answer. */
export type Task<Id, T> = {
  call: (id: Id, key: string, signal: AbortSignal) => Promise<T>;
  accept: (value: T) => boolean;
  empty: string;
};

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs `call`, and once more after `delayMs` if it failed on the network or with a 5xx. */
async function withRetry<T>(call: () => Promise<T>, delayMs: number, signal: AbortSignal): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const retryable = err instanceof NetworkError || (err instanceof HttpError && err.status >= 500);
    if (!retryable || signal.aborted) throw err;
    await pause(delayMs, signal);
    if (signal.aborted) throw err;
    return call();
  }
}

/** Reliability counts more than speed; the floor lets a struggling provider still earn its way back. */
function weight({ success, latencyMs }: ProviderHealth): number {
  return Math.max(success, 0.2) ** 2 * (1_000 / Math.max(latencyMs, 250));
}

function httpCooldown(err: HttpError): number {
  if (err.status === 429) return (err.retryAfter ?? 60) * 1000;
  if (err.status === 401 || err.status === 402 || err.status === 403) return BLOCKED_MS;
  if (err.status === 202 || err.status >= 500) return TRANSIENT_MS;
  return 0;
}

/** Local providers first, then free ones, with keyed ones as the fallback. */
const tier = ({ kind, env }: Routable) => (kind === "local" ? 0 : env ? 2 : 1);

/**
 * Routes one kind of call (search, fetch) across a provider registry. Each call tries local and free
 * providers before keyed ones, favoring those that answer often and fast, starts the next provider
 * alongside a slow one, and gives up once the time budget is spent. Health and cooldowns are stored
 * under `operation/id`, so a service used for both search and fetch keeps separate records.
 */
export function createRouter<R extends Record<string, Routable>>(
  operation: string,
  registry: R,
  options: RouterOptions,
  defaults: { budgetMs: number; hedgeMs: number },
) {
  type Id = keyof R & string;
  type Outcome<T> = { id: Id; value: T } | { id: Id; failure: string };
  const ids = Object.keys(registry).filter((id): id is Id => Object.hasOwn(registry, id));
  const env = options.env ?? process.env;
  const budgetMs = options.budgetMs ?? defaults.budgetMs;
  const hedgeMs = options.hedgeMs ?? defaults.hedgeMs;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const { store } = options;

  const stateKey = (id: Id) => `${operation}/${id}`;
  const get = (id: Id): R[Id] => {
    const provider = registry[id];
    if (!provider) throw new Error(`unknown provider ${String(id)}`);
    return provider;
  };
  const keyFor = (id: Id) => {
    const name = get(id).env;
    return name ? (env[name] ?? "") : "";
  };
  const isReady = (id: Id) => !get(id).env || keyFor(id) !== "";

  /** Tiers first; within a tier, a shuffle weighted by health. */
  const rank = (candidates: Id[], state: RoutingState): Id[] =>
    candidates
      .map((id) => ({
        id,
        tier: tier(get(id)),
        key: Math.log(1 - random()) / weight(state.health[stateKey(id)] ?? NEW_PROVIDER),
      }))
      .sort((a, b) => a.tier - b.tier || b.key - a.key)
      .map(({ id }) => id);

  /** One provider's turn. Records its health and cooldown unless the call was already settled. */
  async function attempt<T>(id: Id, task: Task<Id, T>, signal: AbortSignal): Promise<Outcome<T>> {
    const startedAt = performance.now();
    try {
      const value = await withRetry(() => task.call(id, keyFor(id), signal), retryDelayMs * (1 + random()), signal);
      if (signal.aborted) return { id, failure: "cancelled" };
      if (!task.accept(value)) {
        store.observe(stateKey(id), { success: 0 });
        return { id, failure: task.empty };
      }
      store.observe(stateKey(id), { success: 1, latencyMs: performance.now() - startedAt });
      return { id, value };
    } catch (err) {
      if (signal.aborted) return { id, failure: "cancelled" };
      const failure = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 120) ?? "";
      if (err instanceof TargetError) return { id, failure };
      store.observe(stateKey(id), { success: 0 });
      const ms = err instanceof HttpError ? httpCooldown(err) : err instanceof SoftBlockError ? BLOCKED_MS : TRANSIENT_MS;
      // A local provider's errors come from the page it fetched, not from the provider.
      if (ms > 0 && get(id).kind !== "local") store.bench(stateKey(id), now() + ms);
      return { id, failure };
    }
  }

  /** Runs `task` across `candidates` until one answers, and says what happened to the rest. */
  async function route<T>(candidates: Id[], task: Task<Id, T>): Promise<Routed<T>> {
    const state = store.load();
    const cooling = candidates.filter((id) => (state.benched[stateKey(id)] ?? 0) > now());
    const failures = cooling.map((id) => `${id}: cooling down`);
    const queue = rank(candidates.filter((id) => !cooling.includes(id)), state);

    const stop = new AbortController();
    const budget = setTimeout(() => stop.abort(), budgetMs);
    const expired = new Promise<"expired">((resolve) =>
      stop.signal.addEventListener("abort", () => resolve("expired"), { once: true }),
    );
    const running = new Map<Id, { startedAt: number; outcome: Promise<Outcome<T>> }>();
    const launch = () => {
      const id = queue.shift();
      if (id === undefined || stop.signal.aborted) return;
      running.set(id, { startedAt: performance.now(), outcome: attempt(id, task, stop.signal) });
    };

    try {
      launch();
      while (running.size > 0) {
        const hedge = new AbortController();
        const next = await Promise.race([
          expired,
          pause(hedgeMs, hedge.signal).then(() => "hedge" as const),
          ...[...running.values()].map((run) => run.outcome),
        ]);
        hedge.abort();
        if (next === "expired") {
          failures.push(...[...running.keys()].map((id) => `${id}: timed out`));
          break;
        }
        if (next === "hedge") {
          launch();
          continue;
        }
        running.delete(next.id);
        if ("value" in next) return { success: true, provider: next.id, attempts: failures, data: next.value };
        failures.push(`${next.id}: ${next.failure}`);
        launch();
      }
      return { success: false, error: `All providers failed. ${failures.join("; ")}` };
    } finally {
      clearTimeout(budget);
      // Providers still running lost the race; their elapsed time still counts against their speed.
      for (const [id, run] of running) store.observe(stateKey(id), { latencyMs: performance.now() - run.startedAt });
      stop.abort();
    }
  }

  /** Readiness, cooldown, and health per provider. `successRate` and `latencyMs` are null until it has been tried. */
  function status() {
    const state = store.load();
    return ids.map((id) => {
      const health = state.health[stateKey(id)];
      return {
        id,
        kind: get(id).kind,
        ready: isReady(id),
        needs: isReady(id) ? undefined : get(id).env,
        coolingDownSeconds: Math.max(0, Math.ceil(((state.benched[stateKey(id)] ?? 0) - now()) / 1000)),
        successRate: health ? Math.round(health.success * 100) / 100 : null,
        latencyMs: health ? Math.round(health.latencyMs) : null,
      };
    });
  }

  return { ids, get, isReady, now, route, status };
}
