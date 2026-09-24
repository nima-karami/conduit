import * as fs from 'node:fs';
import { folderKey } from '../src/folder-key';
import { isAncestorOf } from '../src/owning-session';
import { shouldIgnoreWatchPath } from '../src/watch-filter';

type WatchFn = (
  dir: string,
  opts: { recursive: true },
  cb: (event: string, filename: string | Buffer | null) => void,
) => fs.FSWatcher;

export interface FsFire {
  root: string;
  folders: string[];
}

/**
 * Live, debounced watch over the active session's folders (and their `.git`), so the Changes
 * list, file-tree, and git decorations refresh the moment something changes on disk — instead
 * of only when the window regains focus. Noise (node_modules, .git/objects, locks, build dirs) is
 * dropped via shouldIgnoreWatchPath so a dependency install or git's own churn doesn't spam
 * refreshes.
 *
 * A trailing throttle emits ONE fire per `debounceMs` window naming every touched folder
 * (mf-model spec §2.6, B3); a folder nested in another shares its ancestor's recursive watch.
 */
export class ProjectWatcher {
  private folders: string[] = [];
  private keys: string[] = [];
  private readonly watches = new Map<string, fs.FSWatcher>();
  // Folder indexes, never paths, so a 10k-event burst costs nothing to hold (L12 S4).
  private touched = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly log?: (m: string) => void;
  private readonly onSuspect?: (folders: string[]) => void;
  private readonly watchFn: WatchFn;

  constructor(
    private readonly onFire: (fire: FsFire) => void,
    opts: {
      debounceMs?: number;
      log?: (m: string) => void;
      onSuspect?: (folders: string[]) => void;
      watch?: WatchFn;
    } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.log = opts.log;
    this.onSuspect = opts.onSuspect;
    this.watchFn = opts.watch ?? fs.watch;
  }

  setFolders(folders: readonly string[]): void {
    const nextFolders: string[] = [];
    const nextKeys: string[] = [];
    for (const f of folders) {
      const k = folderKey(f);
      if (!f || nextKeys.includes(k)) continue;
      nextFolders.push(f);
      nextKeys.push(k);
    }
    const touchedKeys = [...this.touched].map((i) => this.keys[i]);
    this.folders = nextFolders;
    this.keys = nextKeys;
    this.touched = new Set(touchedKeys.map((k) => nextKeys.indexOf(k)).filter((i) => i >= 0));

    const roots = nextKeys.filter((k) => !nextKeys.some((o) => o !== k && isAncestorOf(o, k)));
    for (const [k, watcher] of this.watches) {
      if (!roots.includes(k)) this.close(k, watcher);
    }
    for (const k of roots) {
      if (!this.watches.has(k)) this.open(k, nextFolders[nextKeys.indexOf(k)]);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [k, watcher] of this.watches) this.close(k, watcher);
    this.folders = [];
    this.keys = [];
    this.touched.clear();
  }

  private open(key: string, dir: string): void {
    try {
      const watcher = this.watchFn(dir, { recursive: true }, (_event, filename) => {
        this.onEvent(key, typeof filename === 'string' ? filename : '');
      });
      watcher.on('error', (e) => {
        this.log?.(`watch error on ${dir}: ${e}`);
        this.close(key, watcher);
        this.onSuspect?.(this.foldersUnder(key).map((i) => this.folders[i]));
      });
      this.watches.set(key, watcher);
    } catch (e) {
      // Recursive watch can fail (e.g. an unsupported FS); degrade to focus-only refresh.
      this.log?.(`failed to watch ${dir}: ${e}`);
      this.onSuspect?.(this.foldersUnder(key).map((i) => this.folders[i]));
    }
  }

  private close(key: string, watcher: fs.FSWatcher): void {
    this.watches.delete(key);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  }

  private foldersUnder(watchKey: string): number[] {
    return this.keys.flatMap((k, i) => (isAncestorOf(watchKey, k) ? [i] : []));
  }

  private onEvent(watchKey: string, filename: string): void {
    if (!filename) {
      const hit = this.foldersUnder(watchKey);
      this.onSuspect?.(hit.map((i) => this.folders[i]));
      this.mark(hit);
      return;
    }
    const segs = filename.split(/[\\/]/).filter(Boolean);
    const absKey = folderKey(`${watchKey}/${segs.join('/')}`);
    const hit = this.keys.flatMap((k, i) => (isAncestorOf(k, absKey) ? [i] : []));
    if (hit.length === 0) return;
    const deepest = hit.reduce((a, b) => (this.keys[b].length > this.keys[a].length ? b : a));
    // Sliced by segment count rather than by the case-folded key, so the filter sees the
    // user's spelling.
    const depth = this.keys[deepest].split('/').length - watchKey.split('/').length;
    if (shouldIgnoreWatchPath(segs.slice(depth).join('/'))) return;
    this.mark(hit);
  }

  private mark(indexes: number[]): void {
    if (indexes.length === 0) return;
    for (const i of indexes) this.touched.add(i);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const folders = [...this.touched].sort((a, b) => a - b).map((i) => this.folders[i]);
      this.touched.clear();
      if (folders.length > 0) this.onFire({ root: folders[0], folders });
    }, this.debounceMs);
  }
}
