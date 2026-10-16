import type { DirtyKind } from './repo-path-map';

// Per-repo refresh pacing: settle, cooldown with a guaranteed trailing run, single-flight per key,
// a host-wide cap and visibility parking. Semantics: docs/plans/2026-10-16-multi-repo-tracking.plan.md
// (Contracts, repo-refresh-scheduler); the tuning is locked by docs/specs/2026-10-16-multi-repo-tracking.md §3.

export const REFRESH_SETTLE_MS = 300;
export const REFRESH_COOLDOWN_MS = 1000;
export const REFRESH_CONCURRENCY = 4;

export interface PendingKinds {
  meta: boolean;
  tree: boolean;
}

export interface RefreshSchedulerDeps {
  run(key: string, kinds: PendingKinds): Promise<void>;
  /** Some visible session contains this repo (union rule). */
  eligible(key: string): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface MarkOptions {
  /** Skip settle+cooldown (explicit action, line-demand upgrade, first fill). */
  immediate?: boolean;
  /** Lower runs first among ready jobs; default 0. First fill passes its rank. */
  priority?: number;
}

export interface RefreshScheduler {
  mark(key: string, kind: DirtyKind, opts?: MarkOptions): void;
  /** Eligibility may have changed; parked-dirty keys that are now eligible get armed. */
  reconsider(): void;
  forget(key: string): void;
  stop(): void;
}

interface Entry {
  pending: PendingKinds | undefined;
  immediate: boolean;
  priority: number;
  timer: unknown;
  armed: boolean;
  parked: boolean;
  queued: number | undefined;
  /** Kept after the run so a later mark still honours the cooldown. */
  lastStart: number;
}

export function createRefreshScheduler(deps: RefreshSchedulerDeps): RefreshScheduler {
  const entries = new Map<string, Entry>();
  const queue = new Set<string>();
  // By key, not entry: a run outlives forget(), and a re-marked key must still wait for it.
  const running = new Set<string>();
  let inFlight = 0;
  let enqueueSeq = 0;
  let stopped = false;

  const disarm = (e: Entry) => {
    if (!e.armed) return;
    deps.clearTimer(e.timer);
    e.armed = false;
    e.timer = undefined;
  };

  const arm = (key: string, e: Entry, delay: number) => {
    e.armed = true;
    e.timer = deps.setTimer(() => {
      e.armed = false;
      e.timer = undefined;
      fire(key, e);
    }, delay);
  };

  const armAfterSettle = (key: string, e: Entry) => {
    const now = deps.now();
    const at = e.immediate
      ? now
      : Math.max(now + REFRESH_SETTLE_MS, e.lastStart + REFRESH_COOLDOWN_MS);
    arm(key, e, at - now);
  };

  const fire = (key: string, e: Entry) => {
    if (entries.get(key) !== e || !e.pending) return;
    if (!deps.eligible(key)) {
      e.parked = true;
      return;
    }
    e.queued = enqueueSeq++;
    queue.add(key);
    drain();
  };

  const nextReady = (): string | undefined => {
    let best: string | undefined;
    let bestEntry: Entry | undefined;
    for (const key of queue) {
      const e = entries.get(key);
      if (!e || e.queued === undefined) continue;
      if (
        !bestEntry ||
        e.priority < bestEntry.priority ||
        (e.priority === bestEntry.priority && e.queued < (bestEntry.queued ?? 0))
      ) {
        best = key;
        bestEntry = e;
      }
    }
    return best;
  };

  const drain = () => {
    while (!stopped && inFlight < REFRESH_CONCURRENCY) {
      const key = nextReady();
      if (key === undefined) return;
      queue.delete(key);
      const e = entries.get(key);
      if (!e?.pending) continue;
      e.queued = undefined;
      if (!deps.eligible(key)) {
        e.parked = true;
        continue;
      }
      start(key, e, e.pending);
    }
  };

  const start = (key: string, e: Entry, kinds: PendingKinds) => {
    e.pending = undefined;
    e.immediate = false;
    e.priority = Number.POSITIVE_INFINITY;
    e.lastStart = deps.now();
    running.add(key);
    inFlight++;
    const done = () => {
      inFlight--;
      running.delete(key);
      const cur = entries.get(key);
      if (!stopped && cur?.pending && !cur.armed && cur.queued === undefined)
        armAfterSettle(key, cur);
      drain();
    };
    // A rejection is the caller's to log (plan Contracts: "logged by the caller"); here it only
    // has to free the key and the slot.
    deps.run(key, kinds).then(done, done);
  };

  return {
    mark(key, kind, opts = {}) {
      if (stopped) return;
      let e = entries.get(key);
      if (!e) {
        e = {
          pending: undefined,
          immediate: false,
          priority: Number.POSITIVE_INFINITY,
          timer: undefined,
          armed: false,
          parked: false,
          queued: undefined,
          lastStart: Number.NEGATIVE_INFINITY,
        };
        entries.set(key, e);
      }
      e.pending = { meta: false, tree: false, ...e.pending, [kind]: true };
      e.priority = Math.min(e.priority, opts.priority ?? 0);
      if (opts.immediate) e.immediate = true;
      if (running.has(key) || e.queued !== undefined) return;
      if (e.armed) {
        if (!opts.immediate) return;
        disarm(e);
      }
      e.parked = false;
      armAfterSettle(key, e);
    },
    reconsider() {
      if (stopped) return;
      for (const [key, e] of entries) {
        if (!e.parked || !e.pending || !deps.eligible(key)) continue;
        e.parked = false;
        // The settle already elapsed while parked; only the cooldown still applies.
        arm(key, e, Math.max(0, e.lastStart + REFRESH_COOLDOWN_MS - deps.now()));
      }
    },
    forget(key) {
      const e = entries.get(key);
      if (!e) return;
      disarm(e);
      queue.delete(key);
      entries.delete(key);
    },
    stop() {
      stopped = true;
      for (const e of entries.values()) disarm(e);
      entries.clear();
      queue.clear();
    },
  };
}
