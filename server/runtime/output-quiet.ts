import type { RuntimeEvent } from '../../src/contracts/terminal-runtime';

export interface OutputQuietDeps {
  on(listener: (e: RuntimeEvent) => void): () => void;
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}

export interface OutputQuiet {
  wait(sessionId: string, quietMs: number, maxMs: number): Promise<void>;
  dispose(): void;
}

interface Waiter {
  sessionId: string;
  start: number;
  quietMs: number;
  resolve: () => void;
  quietTimer: unknown;
  maxTimer: unknown;
}

// see spec 2026-11-13-scheduler-auto-resume R5
export function createOutputQuiet(deps: OutputQuietDeps): OutputQuiet {
  const lastData = new Map<string, number>();
  const waiters = new Set<Waiter>();

  const settle = (w: Waiter) => {
    if (!waiters.delete(w)) return;
    deps.clearTimer(w.quietTimer);
    deps.clearTimer(w.maxTimer);
    w.resolve();
  };

  const arm = (w: Waiter) => {
    deps.clearTimer(w.quietTimer);
    const last = Math.max(w.start, lastData.get(w.sessionId) ?? w.start);
    const remaining = last + w.quietMs - deps.now();
    if (remaining <= 0) {
      settle(w);
      return;
    }
    w.quietTimer = deps.setTimer(remaining, () => arm(w));
  };

  const unsubscribe = deps.on((e) => {
    if (e.type === 'data') lastData.set(e.sessionId, deps.now());
  });

  return {
    wait(sessionId, quietMs, maxMs) {
      return new Promise<void>((resolve) => {
        const w: Waiter = {
          sessionId,
          start: deps.now(),
          quietMs,
          resolve,
          quietTimer: undefined,
          maxTimer: undefined,
        };
        waiters.add(w);
        w.maxTimer = deps.setTimer(maxMs, () => settle(w));
        arm(w);
      });
    },
    dispose() {
      unsubscribe();
      for (const w of [...waiters]) settle(w);
    },
  };
}
