import * as fs from 'node:fs';
import { shouldIgnoreWatchPath } from '../src/watch-filter';

/**
 * Live, debounced watch on the active project's working tree (and its `.git`), so the
 * Changes list, file-tree, and git decorations refresh the moment something changes on disk
 * — instead of only when the window regains focus. Recursive `fs.watch` is native on Windows
 * and macOS (the app's targets); Linux (Node ≥20) is covered too. Noise (node_modules,
 * .git/objects, locks, build dirs) is dropped via shouldIgnoreWatchPath so a dependency
 * install or git's own churn doesn't spam refreshes.
 *
 * One root at a time (the active project). `watch(root)` is idempotent for the same root and
 * re-points to a new one. A single trailing-throttled callback fires per `debounceMs` window
 * of meaningful activity, so a burst of agent edits collapses to a bounded refresh rate.
 */
export class ProjectWatcher {
  private watcher: fs.FSWatcher | null = null;
  private root: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly log?: (m: string) => void;

  constructor(
    private readonly onChange: (root: string) => void,
    opts: { debounceMs?: number; log?: (m: string) => void } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.log = opts.log;
  }

  /** Watch `root` recursively. No-op if already watching it; re-points otherwise. */
  watch(root: string): void {
    if (!root) return;
    if (this.root === root && this.watcher) return;
    this.stop();
    this.root = root;
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        const rel = typeof filename === 'string' ? filename : '';
        if (shouldIgnoreWatchPath(rel)) return;
        this.schedule();
      });
      this.watcher.on('error', (e) => {
        this.log?.(`watch error on ${root}: ${e}`);
        this.stop();
      });
    } catch (e) {
      // Recursive watch can fail (e.g. an unsupported FS); degrade to focus-only refresh.
      this.log?.(`failed to watch ${root}: ${e}`);
      this.watcher = null;
      this.root = null;
    }
  }

  private schedule(): void {
    if (this.timer) return; // already a pending fire within this window
    const root = this.root;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (root) this.onChange(root);
    }, this.debounceMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* already closed */
      }
      this.watcher = null;
    }
    this.root = null;
  }
}
