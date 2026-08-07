/**
 * Pure bookkeeping for the streamed project index: how much has reached the language worker,
 * and whether it is complete. Monaco-free so it loads in the node test env — the
 * monaco-bound half lives in `ts-project.ts` (same split as monaco-warmup / -bind).
 *
 * "Complete" is the load-bearing bit: it's what lets a navigation that found nothing tell the
 * user "still indexing" instead of "no definition found".
 */

export interface IndexProgress {
  /** Source files the host selected, summed over every indexed root. */
  total: number;
  /** Files whose content has been handed to the worker. */
  loaded: number;
  /** True once every root has streamed its final chunk. False when nothing is indexed. */
  done: boolean;
}

export interface IndexTracker {
  /** Record a chunk's metadata (not its files). */
  note(root: string, total: number, done: boolean): void;
  /** Record that `n` more files reached the worker. */
  markLoaded(n: number): void;
  status(): IndexProgress;
  reset(): void;
}

export function createIndexTracker(): IndexTracker {
  const roots = new Map<string, { total: number; done: boolean }>();
  let loaded = 0;
  return {
    note(root, total, done) {
      roots.set(root, { total, done });
    },
    markLoaded(n) {
      loaded += n;
    },
    status() {
      let total = 0;
      // Nothing indexed is NOT "done" — reporting it as complete would make every failed
      // lookup in a fresh window claim the symbol doesn't exist.
      let done = roots.size > 0;
      for (const r of roots.values()) {
        total += r.total;
        if (!r.done) done = false;
      }
      return { total, loaded, done };
    },
    reset() {
      roots.clear();
      loaded = 0;
    },
  };
}

/**
 * Whether a chunk must reach the worker now rather than waiting for more to arrive. The
 * priority wave (seq 0) is the reason the first navigation of a session is fast, and the
 * final chunk has to land before `done` is reported — everything between them coalesces,
 * because each push re-sends the whole extraLib map.
 */
export function flushImmediately(seq: number, done: boolean): boolean {
  return seq === 0 || done;
}
