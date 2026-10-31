// Node-free. One lifecycle for "a call waiting on one window": asks now, Part B's mcp:ui requests
// later, as separate instances (plan 2026-10-30-conduit-mcp-tool-policy, Architecture).
import type { JsonRpcId } from './json-rpc';

export interface CallKey {
  connId: number;
  requestId: JsonRpcId;
}
export interface Wait<M> {
  id: string;
  callerSessionId: string;
  key: CallKey;
  /** The window the request was sent to; only it may answer. */
  windowId: number;
  openedAt: number;
  meta: M;
}
export type WaitEnd<A> =
  | { kind: 'answered'; answer: A }
  | { kind: 'expired' }
  /** reply false: the CLI cancelled or its connection closed, so nothing is sent back. */
  | { kind: 'cancelled'; reply: boolean };
export type UnansweredEnd = { kind: 'expired' } | { kind: 'cancelled'; reply: boolean };
export interface WindowWaitsDeps<M> {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Once per wait that ends without an answer. */
  onUnanswered(wait: Wait<M>, end: UnansweredEnd): void;
}
export interface WindowWaits<A, M> {
  countFor(callerSessionId: string): number;
  open(wait: Omit<Wait<M>, 'openedAt'>, timeoutMs: number): Promise<WaitEnd<A>>;
  /** false when unknown, already ended, or `fromWindowId` isn't the wait's window. */
  answer(id: string, fromWindowId: number, answer: A): boolean;
  /** Ends every matching wait as cancelled; returns how many. */
  cancel(match: (w: Wait<M>) => boolean, reply: boolean): number;
  pending(): readonly Wait<M>[];
  /** Cancels everything with reply false (host stop). */
  dispose(): void;
}

interface Entry<A, M> {
  wait: Wait<M>;
  timer: unknown;
  resolve(end: WaitEnd<A>): void;
}

export function createWindowWaits<A, M>(deps: WindowWaitsDeps<M>): WindowWaits<A, M> {
  const entries = new Map<string, Entry<A, M>>();

  // Removing the entry first is what makes every end single: a late timer, answer or cancel finds
  // nothing to end.
  const end = (e: Entry<A, M>, how: WaitEnd<A>) => {
    entries.delete(e.wait.id);
    deps.clearTimer(e.timer);
    if (how.kind !== 'answered') deps.onUnanswered(e.wait, how);
    e.resolve(how);
  };

  const cancel = (match: (w: Wait<M>) => boolean, reply: boolean): number => {
    const hit = [...entries.values()].filter((e) => match(e.wait));
    for (const e of hit) end(e, { kind: 'cancelled', reply });
    return hit.length;
  };

  return {
    countFor: (callerSessionId) => {
      let n = 0;
      for (const e of entries.values()) if (e.wait.callerSessionId === callerSessionId) n++;
      return n;
    },
    open: (w, timeoutMs) =>
      new Promise<WaitEnd<A>>((resolve) => {
        const wait: Wait<M> = { ...w, openedAt: deps.now() };
        const entry: Entry<A, M> = { wait, timer: undefined, resolve };
        entries.set(wait.id, entry);
        entry.timer = deps.setTimer(() => {
          if (entries.get(wait.id) === entry) end(entry, { kind: 'expired' });
        }, timeoutMs);
      }),
    answer: (id, fromWindowId, answer) => {
      const e = entries.get(id);
      if (!e || e.wait.windowId !== fromWindowId) return false;
      end(e, { kind: 'answered', answer });
      return true;
    },
    cancel,
    pending: () => [...entries.values()].map((e) => e.wait),
    dispose: () => {
      cancel(() => true, false);
    },
  };
}
