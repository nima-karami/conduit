// Node-free. Blocked-call registry for the request queue (plan 2026-11-14-request-queue-machinery, C6).
import type { CallKey } from './window-waits';

const REQUEST_WAIT_MARGIN_MS = 10_000;
const REQUEST_REPLY_MARGIN_MS = 5_000;
export const REQUEST_WAITS_PER_CALLER = 4;

type WaitEnd = { kind: 'ended' } | { kind: 'timeout' } | { kind: 'cancelled' };

export interface RequestWaits {
  open(w: {
    requestId: string;
    sessionId: string;
    key: CallKey;
    timeoutMs: number;
  }): Promise<WaitEnd>;
  ended(requestId: string): void;
  cancel(match: (w: { sessionId: string; key: CallKey }) => boolean): void;
  isWaiting(requestId: string): boolean;
  countFor(sessionId: string): number;
  dispose(): void;
}

interface Entry {
  requestId: string;
  sessionId: string;
  key: CallKey;
  timer: unknown;
  resolve(end: WaitEnd): void;
}

export function createRequestWaits(deps: {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  onWaitingChanged(): void;
}): RequestWaits {
  // Each entry is its own object, so a wait is identified by identity, not by request id: one
  // request can have several blocked calls, each of which must resolve on its own.
  const entries = new Set<Entry>();

  // Leaving the set before resolving is what makes each wait end once: a late timer or a second
  // batch call finds nothing left to end.
  const remove = (e: Entry, how: WaitEnd) => {
    entries.delete(e);
    deps.clearTimer(e.timer);
    e.resolve(how);
  };

  // One notification per batch, so a call that ends several waits does not flood the listener.
  const endWhere = (match: (e: Entry) => boolean, how: WaitEnd) => {
    const hit = [...entries].filter(match);
    for (const e of hit) remove(e, how);
    if (hit.length > 0) deps.onWaitingChanged();
  };

  return {
    open: (w) => {
      // Zero budget is answered without arming a timer, so it never shows up as a waiting call.
      if (w.timeoutMs <= 0) return Promise.resolve<WaitEnd>({ kind: 'timeout' });
      return new Promise<WaitEnd>((resolve) => {
        const entry: Entry = {
          requestId: w.requestId,
          sessionId: w.sessionId,
          key: w.key,
          timer: undefined,
          resolve,
        };
        entries.add(entry);
        entry.timer = deps.setTimer(() => {
          if (!entries.has(entry)) return;
          remove(entry, { kind: 'timeout' });
          deps.onWaitingChanged();
        }, w.timeoutMs);
        deps.onWaitingChanged();
      });
    },
    ended: (requestId) => {
      endWhere((e) => e.requestId === requestId, { kind: 'ended' });
    },
    cancel: (match) => {
      endWhere((e) => match({ sessionId: e.sessionId, key: e.key }), { kind: 'cancelled' });
    },
    isWaiting: (requestId) => {
      for (const e of entries) if (e.requestId === requestId) return true;
      return false;
    },
    countFor: (sessionId) => {
      let n = 0;
      for (const e of entries) if (e.sessionId === sessionId) n++;
      return n;
    },
    dispose: () => {
      endWhere(() => true, { kind: 'cancelled' });
    },
  };
}

export function requestWaitMs(
  waitS: number | null,
  budgetMs: number,
): { ms: number; clampedTo?: number } {
  if (waitS === null) return { ms: Math.max(0, budgetMs - REQUEST_WAIT_MARGIN_MS) };
  const limit = Math.max(0, budgetMs - REQUEST_REPLY_MARGIN_MS);
  if (waitS * 1000 > limit) return { ms: limit, clampedTo: Math.floor(limit / 1000) };
  return { ms: waitS * 1000 };
}
