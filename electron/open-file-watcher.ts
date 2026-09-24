// Watches the set of files currently open in editor/markdown tabs so the renderer
// can refresh a tab when its file changes on disk (an agent, an external editor, or
// a terminal command wrote it). The renderer sends the full open-file path set via
// `watchFiles`; on a change the host emits `fileChanged` and the renderer re-reads
// (dirty-buffer protection in app.tsx still withholds clobbering an unsaved buffer).
//
// We watch each file's PARENT directory (deduped) and filter raw events to the exact
// basenames we care about — NOT the files directly. Direct file watches are unreliable
// on Windows because editors and agents commonly save via atomic write-temp-then-rename,
// which destroys the inode the file watch was bound to; a directory watch still sees the
// rename land. Each changed path is debounced so a burst of writes yields one refresh.

import * as path from 'node:path';
import { type DirWatch, watchDirWhilePresent } from './watch-dir';

const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Pure plan: group absolute file paths by their parent directory, mapping each dir to
 * the set of basenames to watch within it. Extracted so the grouping/dedup logic is
 * unit-testable without touching the filesystem.
 */
export function planWatchDirs(paths: readonly string[]): Map<string, Set<string>> {
  const byDir = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!p) continue;
    const dir = path.dirname(p);
    const base = path.basename(p);
    let set = byDir.get(dir);
    if (!set) {
      set = new Set<string>();
      byDir.set(dir, set);
    }
    set.add(base);
  }
  return byDir;
}

/** Key combining a directory and a basename, used to recover the original full path. */
function key(dir: string, base: string): string {
  return `${dir}\0${base}`;
}

export class OpenFileWatcher {
  private dirWatchers = new Map<string, DirWatch>();
  private watchedByDir = new Map<string, Set<string>>();
  private fullByKey = new Map<string, string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onChange: (filePath: string) => void,
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
  ) {}

  /**
   * Replace the watched set with exactly `paths`. Idempotent: re-sending the same set
   * is cheap (dirs already watched are reused; dirs no longer needed are dropped).
   */
  setPaths(paths: readonly string[]): void {
    const wanted = planWatchDirs(paths);

    this.fullByKey.clear();
    for (const p of paths) {
      if (!p) continue;
      this.fullByKey.set(key(path.dirname(p), path.basename(p)), p);
    }

    for (const [dir, watcher] of this.dirWatchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.dirWatchers.delete(dir);
      }
    }

    this.watchedByDir = wanted;

    for (const dir of wanted.keys()) {
      if (this.dirWatchers.has(dir)) continue;
      this.dirWatchers.set(
        dir,
        watchDirWhilePresent(dir, {}, (_event, filename) => {
          // null — the platform omitted the name, or the dir came back — may mean any of them.
          const names = filename ? [filename] : [...(this.watchedByDir.get(dir) ?? [])];
          for (const name of names) {
            if (!this.watchedByDir.get(dir)?.has(name)) continue;
            const full = this.fullByKey.get(key(dir, name));
            if (full) this.schedule(full);
          }
        }),
      );
    }
  }

  private schedule(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.onChange(filePath);
      }, this.debounceMs),
    );
  }

  /** Tear down every watcher and pending debounce. */
  stop(): void {
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    this.watchedByDir.clear();
    this.fullByKey.clear();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }
}
