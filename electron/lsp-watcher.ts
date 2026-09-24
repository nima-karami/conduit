// Per-server-root recursive watch feeding workspace/didChangeWatchedFiles. Knows no language:
// the filter is compiled from the registry's watchGlobs by the caller. ProjectWatcher is not
// reused — it is single-root and reports no paths (spec §3.7).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shouldIgnoreWatchPath } from '../src/watch-filter';
import { type DirWatch, type WatchFn, watchDir } from './watch-dir';

/** LSP FileChangeType: Created 1 | Changed 2 | Deleted 3. */
export interface WatchedChange {
  path: string;
  type: 1 | 2 | 3;
}
export interface LspWatcherHandle {
  close(): void;
}

const COALESCE_MS = 200;

const defaultStat = (p: string): Promise<boolean> =>
  fs.promises.stat(p).then(
    () => true,
    () => false,
  );

export function watchServerRoot(
  root: string,
  filter: { matches: (rel: string) => boolean; isMarker: (rel: string) => boolean },
  onChanges: (c: WatchedChange[]) => void,
  onMarker: () => void,
  onGone: () => void,
  deps: {
    watch?: WatchFn;
    stat?: (p: string) => Promise<boolean>;
    log?: (m: string) => void;
  } = {},
): LspWatcherHandle {
  const stat = deps.stat ?? defaultStat;
  /** rel → whether its LAST event in this window was a 'rename'. */
  let pending = new Map<string, boolean>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: DirWatch | null = null;
  let closed = false;
  /** Batches are delivered in order, so the one flushed on a vanish lands after any in flight. */
  let delivered: Promise<void> = Promise.resolve();

  const deliver = async (batch: Map<string, boolean>) => {
    const changes: WatchedChange[] = [];
    let marker = false;
    for (const [rel, renamed] of batch) {
      const abs = path.join(root, rel);
      const exists = await stat(abs);
      changes.push({ path: abs, type: !exists ? 3 : renamed ? 1 : 2 });
      if (filter.isMarker(rel)) marker = true;
    }
    if (closed) return;
    if (changes.length > 0) onChanges(changes);
    if (marker) onMarker();
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = pending;
    pending = new Map();
    delivered = delivered.then(() => deliver(batch));
    return delivered;
  };

  const close = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
  };

  const gone = () => {
    if (closed) return;
    closed = true;
    onGone();
  };

  try {
    watcher = watchDir(
      root,
      { recursive: true, watch: deps.watch },
      (event, filename) => {
        const rel = filename ?? '';
        if (!rel || shouldIgnoreWatchPath(rel) || !filter.matches(rel)) return;
        pending.set(rel, event === 'rename');
        if (!timer) timer = setTimeout(() => void flush(), COALESCE_MS);
      },
      (err) => {
        deps.log?.(
          err ? `lsp watch error on ${root}: ${err}` : `lsp watched root vanished: ${root}`,
        );
        watcher = null;
        // The root's entries — a root marker among them — are reported just before the root.
        void flush().then(gone);
      },
    );
  } catch (e) {
    deps.log?.(`lsp failed to watch ${root}: ${e}`);
    void Promise.resolve().then(gone);
  }
  return { close };
}
