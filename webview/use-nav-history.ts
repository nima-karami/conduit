import { type RefObject, useCallback, useRef, useState } from 'react';
import {
  type ApplyResult,
  EMPTY_NAV,
  type NavState,
  record,
  traverse,
  updateCurrent,
} from '../src/nav-history';
import { EDITOR_NAV_OPS, type NavEntry } from './editor-nav';
import { log } from './log';

export interface NavHistoryDeps {
  /** The active view as an entry, with the live cursor for a file; null for a Terminal tab / no doc (F3). */
  currentEntry(): NavEntry | null;
  /** Sync liveness (spec §2.4): an unopened file is only tentatively live; `apply` probes it. */
  isLive(e: NavEntry): boolean;
  apply(e: NavEntry): Promise<ApplyResult>;
}

export interface NavHistory {
  state: NavState<NavEntry>;
  recordNav(to: NavEntry): void;
  recordJump(from: NavEntry, to: NavEntry): void;
  goBack(): void;
  goForward(): void;
}

type Op = () => void | Promise<void>;

/**
 * Editor Back/Forward (docs/specs/2026-09-22-editor-nav-history.md). Recording is imperative —
 * producers call recordNav/recordJump at the user-intent site — and every record and apply runs
 * through one serial queue, so an apply's own landing can never interleave with another op.
 */
export function useNavHistory(deps: RefObject<NavHistoryDeps>): NavHistory {
  const [state, setState] = useState<NavState<NavEntry>>(EMPTY_NAV);
  const stateRef = useRef<NavState<NavEntry>>(EMPTY_NAV);
  const queue = useRef<Op[]>([]);
  const draining = useRef(false);

  const commit = useCallback((s: NavState<NavEntry>) => {
    stateRef.current = s;
    setState(s);
  }, []);

  // Runs synchronously while ops are sync, so an idle-queue record lands before the caller's
  // next statement; only an apply's await yields.
  const drain = useCallback(async () => {
    draining.current = true;
    for (let op = queue.current.shift(); op; op = queue.current.shift()) {
      const before = stateRef.current;
      try {
        const pending = op();
        if (pending instanceof Promise) await pending;
      } catch (err) {
        log.error('nav', 'apply failed', { error: String(err) });
        commit(before);
      }
    }
    draining.current = false;
  }, [commit]);

  const enqueue = useCallback(
    (op: Op) => {
      queue.current.push(op);
      if (!draining.current) void drain();
    },
    [drain],
  );

  const recordNav = useCallback(
    (to: NavEntry) => {
      const from = deps.current.currentEntry();
      enqueue(() => commit(record(stateRef.current, from, to, EDITOR_NAV_OPS)));
    },
    [deps, enqueue, commit],
  );

  const recordJump = useCallback(
    (from: NavEntry, to: NavEntry) => {
      enqueue(() => commit(record(stateRef.current, from, to, EDITOR_NAV_OPS)));
    },
    [enqueue, commit],
  );

  const step = useCallback(
    (dir: -1 | 1) => {
      enqueue(async () => {
        const d = deps.current;
        const live = d.currentEntry();
        const st = live ? updateCurrent(stateRef.current, live, EDITOR_NAV_OPS) : stateRef.current;
        commit(await traverse(st, dir, d.isLive, d.apply));
      });
    },
    [deps, enqueue, commit],
  );

  const goBack = useCallback(() => step(-1), [step]);
  const goForward = useCallback(() => step(1), [step]);

  return { state, recordNav, recordJump, goBack, goForward };
}
