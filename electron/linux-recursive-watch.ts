import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WatchFn } from './watch-dir';

// Linux has no recursive inotify: Node's `fs.watch(dir, { recursive: true })` adds one watch per
// directory with no ignore list, so a repo's node_modules and .git/objects cost thousands of the
// 65 536 watches every app on the machine shares. This walks the tree itself and opens one
// non-recursive watch per kept directory. See spec CON-9.

export interface RecursiveWatchOpts {
  /** Root-relative, forward-slash directory path: true leaves the directory unwatched. */
  ignore: (rel: string) => boolean;
  watch?: WatchFn;
  /**
   * Receives an ENOSPC/EMFILE from opening a watch. Defaults to `onError`. The watches already
   * open are kept: the limit costs coverage, not the whole tree.
   */
  onLimit?: (error: Error) => void;
  /**
   * A child directory that cannot be read or watched (EACCES/EPERM) is skipped with its subtree,
   * reported once per directory (default: a console warning). The rest of the watch stays alive.
   */
  onSkip?: (rel: string, error: Error) => void;
  /** Tests only: the directory listing, so an unreadable folder can be simulated anywhere. */
  readdir?: (dir: string) => Promise<fs.Dirent[]>;
}

export interface RecursiveWatch {
  close(): void;
}

/** The inotify and fd limits: an open that hits one stops the walk, it does not end the tree. */
export function isWatchLimit(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EMFILE';
}

/** A child directory the process may not read: skipped, not a reason to end the whole watch. */
const isUnreadable = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
};

/**
 * A directory that vanished between being listed and being opened: expected while a tree
 * changes under the walk, and the parent's rename event is what settles it.
 */
const isGoneRace = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * Watches `root` and every directory under it that `opts.ignore` keeps. Symlinked directories
 * are never followed. `onEvent` gets forward-slash paths relative to `root` (null for an event
 * with no name). `onError` gets the error that ends the whole watch (`undefined` when `root`
 * itself is removed), after which everything is closed. Throws if `root` cannot be opened.
 */
export function createRecursiveWatch(
  root: string,
  opts: RecursiveWatchOpts,
  onEvent: (event: string, rel: string | null) => void,
  onError: (error?: Error) => void,
): RecursiveWatch {
  const watch = opts.watch ?? fs.watch;
  const readdir =
    opts.readdir ?? ((dir: string) => fs.promises.readdir(dir, { withFileTypes: true }));
  const onLimit = opts.onLimit ?? onError;
  const rootName = path.basename(root);
  const watchers = new Map<string, fs.FSWatcher>();
  const skipped = new Set<string>();
  let closed = false;
  // Once the limit is hit no new watch is opened: the walk stops, the existing ones stay.
  let limited = false;

  const abs = (rel: string) => (rel === '' ? root : path.join(root, ...rel.split('/')));

  const closeAll = () => {
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };

  const fail = (error?: Error) => {
    if (closed) return;
    closeAll();
    closed = true;
    onError(error);
  };

  /** Closes the watch on `rel` and on every watched directory beneath it. */
  const drop = (rel: string) => {
    for (const [key, w] of [...watchers]) {
      if (key !== rel && !key.startsWith(`${rel}/`)) continue;
      watchers.delete(key);
      w.close();
    }
  };

  const isPresent = async (p: string): Promise<boolean> => {
    try {
      await fs.promises.lstat(p);
      return true;
    } catch (error) {
      if (isGoneRace(error)) return false;
      throw error;
    }
  };

  /** An unreadable child: its subtree is dropped and the rest of the watch carries on. */
  const skip = (rel: string, error: Error) => {
    drop(rel);
    if (skipped.has(rel)) return;
    skipped.add(rel);
    (opts.onSkip ?? ((r, e) => console.warn(`[watch] skipped ${r}: ${e}`)))(rel, error);
  };

  /** Opens the watch on `rel`; false when it was not opened (limit, raced removal, closed). */
  const open = (rel: string): boolean => {
    if (closed || limited) return false;
    let w: fs.FSWatcher;
    try {
      w = watch(abs(rel), { recursive: false }, (event, name) => onChild(rel, event, name));
    } catch (error) {
      if (rel === '') throw error;
      if (isWatchLimit(error)) {
        limited = true;
        onLimit(error as Error);
        return false;
      }
      if (isGoneRace(error)) return false;
      if (isUnreadable(error)) {
        skip(rel, error as Error);
        return false;
      }
      fail(error as Error);
      return false;
    }
    w.on('error', (error: Error) => fail(error));
    watchers.set(rel, w);
    return true;
  };

  /**
   * Settles what `rel` is now: gone drops its watches (the root being gone ends the watch), a
   * new directory that is kept gets walked, anything else is left alone. `lstat`, so a symlink
   * is never taken for a directory.
   */
  const reconcile = async (rel: string): Promise<void> => {
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(abs(rel));
    } catch (error) {
      if (closed) return;
      if (rel !== '' && isUnreadable(error)) return skip(rel, error as Error);
      if (!isGoneRace(error)) return fail(error as Error);
      if (rel === '') return fail(undefined);
      return drop(rel);
    }
    if (closed) return;
    if (rel === '') return;
    if (!st.isDirectory()) return drop(rel);
    if (!opts.ignore(rel) && !watchers.has(rel)) void walk(rel).catch(fail);
  };

  const onChild = (dirRel: string, event: string, name: string | Buffer | null) => {
    if (closed) return;
    if (typeof name !== 'string') return onEvent(event, dirRel === '' ? null : dirRel);
    if (event === 'rename' && dirRel === '' && name === rootName) {
      // The root's own name, reported by its own watch: the root is gone, or a child shares the
      // name. Only the stat says which, so nothing is reported until it does.
      void isPresent(root).then((present) => {
        if (closed) return;
        if (!present) return fail(undefined);
        onEvent(event, name);
        void reconcile(name).catch(fail);
      }, fail);
      return;
    }
    const rel = dirRel === '' ? name : `${dirRel}/${name}`;
    onEvent(event, rel);
    if (event !== 'rename') return;
    void reconcile(rel).catch(fail);
    // A watched directory deleted from inside reports its own name in its own watch.
    if (dirRel !== '' && name === path.basename(dirRel)) void reconcile(dirRel).catch(fail);
  };

  /** Breadth-first: a shallow watch (a repo's HEAD, its refs) is opened before a deep one. */
  const walk = async (start: string): Promise<void> => {
    const queue = [start];
    while (queue.length > 0) {
      if (closed || limited) return;
      const rel = queue.shift() as string;
      if (!watchers.has(rel) && !open(rel)) continue;
      let entries: fs.Dirent[];
      try {
        entries = await readdir(abs(rel));
      } catch (error) {
        if (closed) return;
        if (rel !== '' && isUnreadable(error)) {
          skip(rel, error as Error);
          continue;
        }
        if (!isGoneRace(error)) return fail(error as Error);
        await reconcile(rel);
        continue;
      }
      if (closed) return;
      for (const entry of entries) {
        // A symlink is not isDirectory(), so a link to a directory is never walked into.
        if (!entry.isDirectory()) continue;
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (opts.ignore(child) || watchers.has(child)) continue;
        queue.push(child);
      }
    }
  };

  // The root opens synchronously so a root that cannot be watched throws to the caller.
  if (!open('')) throw new Error(`could not watch ${root}`);
  void walk('').catch(fail);

  return {
    close() {
      if (closed) return;
      closed = true;
      closeAll();
    },
  };
}
