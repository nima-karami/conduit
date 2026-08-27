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
  /** Source files too big to index, summed over every root — what a miss can honestly blame. */
  skipped: number;
  /** Source files the host's file cap left out, summed over every root. */
  capped: number;
}

/**
 * One chunk's bookkeeping. `supplemental` marks a top-up batch for a root that already
 * finished (the `fsChanged` path): its `total` ADDS to the root's running total, because those
 * files are new rather than a re-count. `skipped`/`capped` are absolute per-root counts the
 * host recomputed, so they replace either way.
 */
export interface IndexNote {
  total: number;
  done: boolean;
  skipped: number;
  capped: number;
  supplemental?: boolean;
}

export interface IndexTracker {
  /** Record a chunk's metadata (not its files). */
  note(root: string, note: IndexNote): void;
  /** Record that `n` more files reached the worker. */
  markLoaded(n: number): void;
  status(): IndexProgress;
  reset(): void;
}

export function createIndexTracker(): IndexTracker {
  const roots = new Map<
    string,
    { total: number; done: boolean; skipped: number; capped: number }
  >();
  let loaded = 0;
  return {
    note(root, n) {
      const prev = roots.get(root);
      const total = n.supplemental && prev ? prev.total + n.total : n.total;
      roots.set(root, { total, done: n.done, skipped: n.skipped, capped: n.capped });
    },
    markLoaded(n) {
      loaded += n;
    },
    status() {
      let total = 0;
      let skipped = 0;
      let capped = 0;
      // Nothing indexed is NOT "done" — reporting it as complete would make every failed
      // lookup in a fresh window claim the symbol doesn't exist.
      let done = roots.size > 0;
      for (const r of roots.values()) {
        total += r.total;
        skipped += r.skipped;
        capped += r.capped;
        if (!r.done) done = false;
      }
      return { total, loaded, done, skipped, capped };
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
