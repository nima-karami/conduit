// At most one `readDiff` in flight per open-tab key. The protocol carries no request id, so
// without this an older reply could land after a newer one and overwrite it. See spec
// 2026-09-22-scoped-diff-tabs §3 "Ordering".

import type { DiffTabScope } from '../src/protocol';
import { diffTabKey } from './diff-tab-scope';
import type { OpenDoc } from './docs';

export interface DiffReadTarget {
  path: string;
  diffScope?: DiffTabScope;
}

export interface DiffReadQueue {
  /** Content may be stale: post now if idle, else mark dirty (one re-post when the reply lands). */
  request(target: DiffReadTarget): void;
  /** Content is missing: post only if nothing is in flight for this key; never marks dirty. */
  ensure(target: DiffReadTarget): void;
  /** A fileDiff for `key` arrived: re-post once if dirty, else go idle. Unknown keys are ignored. */
  settle(key: string): void;
}

export function createDiffReadQueue(send: (target: DiffReadTarget) => void): DiffReadQueue {
  const state = new Map<string, { status: 'inFlight' | 'dirty'; target: DiffReadTarget }>();
  const post = (key: string, target: DiffReadTarget) => {
    state.set(key, { status: 'inFlight', target });
    send(target);
  };
  return {
    request(target) {
      const key = diffTabKey(target);
      const cur = state.get(key);
      if (cur) cur.status = 'dirty';
      else post(key, target);
    },
    ensure(target) {
      const key = diffTabKey(target);
      if (!state.has(key)) post(key, target);
    },
    settle(key) {
      const cur = state.get(key);
      if (!cur) return;
      if (cur.status === 'dirty') post(key, cur.target);
      else state.delete(key);
    },
  };
}

export function diffReadTargets(
  docs: readonly OpenDoc[],
  match: (doc: OpenDoc) => boolean,
): DiffReadTarget[] {
  const seen = new Set<string>();
  const out: DiffReadTarget[] = [];
  for (const d of docs) {
    if (d.kind !== 'diff' || !match(d)) continue;
    const key = diffTabKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d.diffScope ? { path: d.path, diffScope: d.diffScope } : { path: d.path });
  }
  return out;
}
