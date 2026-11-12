import * as fs from 'node:fs';
import * as path from 'node:path';
import { folderKey } from '../src/folder-key';
import { shouldIgnoreWatchPath } from '../src/watch-filter';
import { createRecursiveWatch, type RecursiveWatch } from './linux-recursive-watch';

export type WatchFn = (
  dir: string,
  opts: { recursive?: boolean },
  cb: (event: string, filename: string | Buffer | null) => void,
) => fs.FSWatcher;

export interface DirWatch {
  close(): void;
}

/** How often a missing watched directory is looked for again. */
export const EXISTS_POLL_MS = 2000;

const LONG_PATH = /^\\\\\?\\(UNC\\)?/i;
const WIN_ABSOLUTE = /^([a-z]:[\\/]|[\\/]{2})/i;

/**
 * The directory as libuv names it in that self-event: the argument resolved against the cwd. A
 * drive or UNC path resolves the Windows way on every platform, so the match is testable on CI.
 * 8.3 short names are not expanded (libuv's `GetLongPathNameW`), so such an argument never matches.
 */
function resolveWatchDir(dir: string): string {
  return WIN_ABSOLUTE.test(dir) ? path.win32.resolve(dir) : path.resolve(dir);
}

/**
 * Whether a watch event names the watched directory itself. On Windows, once that directory is
 * deleted — recursive watch or not — libuv reports its own `\\?\` path as a `rename` in a tight
 * loop (~80 000/s) until the watch is closed, and never an 'error'. An entry inside the directory
 * is always reported relative, never this way.
 */
export function namesWatchedDir(dir: string, filename: string): boolean {
  const m = LONG_PATH.exec(filename);
  if (!m) return false;
  const rest = filename.slice(m[0].length);
  return folderKey(m[1] ? `\\\\${rest}` : rest) === folderKey(dir);
}

export interface WatchDirOpts {
  recursive?: boolean;
  watch?: WatchFn;
  /**
   * Linux recursive watches only: the directories to leave unwatched, root-relative. Defaults to
   * `shouldIgnoreWatchPath`. A caller watching something other than a project tree passes its own.
   */
  ignore?: (rel: string) => boolean;
  /**
   * Linux recursive watches only: receives an ENOSPC/EMFILE. The watch keeps the directories it
   * already has and `onGone` is not called. Without it a limit error goes to `onGone`.
   */
  onLimit?: (error: Error) => void;
  /**
   * Linux recursive watches only: a directory that cannot be read or watched (EACCES/EPERM) is
   * skipped with its subtree, and the rest stays live. Defaults to a console warning, so a skipped
   * folder is never silent.
   */
  onSkip?: (rel: string, error: Error) => void;
  /** Tests only; the real platform is used otherwise. */
  platform?: NodeJS.Platform;
}

/**
 * `fs.watch` on a directory that cannot outlive it: the directory vanishing, or the watch
 * erroring, closes the watch and calls `onGone` exactly once (`error` is undefined for a
 * vanish). What "gone" means — drop, mark missing, re-arm later — is the caller's decision.
 * Throws whatever `fs.watch` throws when the watch cannot be opened.
 *
 * On Linux a recursive watch is a walk with one non-recursive watch per kept directory
 * (`linux-recursive-watch.ts`): Node's own recursive watch there has no ignore list and costs
 * an inotify watch on every node_modules directory too.
 */
export function watchDir(
  dir: string,
  opts: WatchDirOpts,
  onEvent: (event: string, filename: string | null) => void,
  onGone: (error?: Error) => void,
): DirWatch {
  if (opts.recursive && (opts.platform ?? process.platform) === 'linux') {
    return watchTree(dir, opts, onEvent, onGone);
  }
  const watch = opts.watch ?? fs.watch;
  const target = resolveWatchDir(dir);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  };
  const gone = (error?: Error) => {
    if (closed) return;
    close();
    onGone(error);
  };
  const watcher = watch(dir, { recursive: opts.recursive ?? false }, (event, filename) => {
    if (closed) return;
    const name = typeof filename === 'string' ? filename : null;
    if (name !== null && namesWatchedDir(target, name)) return gone();
    onEvent(event, name);
  });
  watcher.on('error', (e) => gone(e));
  return { close };
}

function watchTree(
  dir: string,
  opts: WatchDirOpts,
  onEvent: (event: string, filename: string | null) => void,
  onGone: (error?: Error) => void,
): DirWatch {
  let closed = false;
  let tree: RecursiveWatch | undefined;
  const stop = () => {
    if (closed) return;
    closed = true;
    tree?.close();
  };
  tree = createRecursiveWatch(
    dir,
    {
      ignore: opts.ignore ?? shouldIgnoreWatchPath,
      watch: opts.watch,
      onLimit: opts.onLimit,
      onSkip: opts.onSkip,
    },
    (event, rel) => {
      if (!closed) onEvent(event, rel);
    },
    (error) => {
      if (closed) return;
      stop();
      onGone(error);
    },
  );
  return { close: stop };
}

/**
 * A `watchDir` for a directory that may not exist yet, or may be deleted and recreated (a branch
 * switch): while it is missing — at start, after a vanish, or after an 'error' — it is looked for
 * every `EXISTS_POLL_MS` and watched again once it is back. Never creates the directory and never
 * throws. What changed while it was unwatched is not replayed per file: an arm that ends a missing
 * phase emits one `('rename', null)` instead, so the caller re-reads everything — a checkout, or a
 * `mkdir -p` and write, lands the content before the poll arms. A directory that is there but
 * cannot be watched is retried on the same poll, and logged once until it next goes missing.
 */
export function watchDirWhilePresent(
  dir: string,
  opts: Pick<WatchDirOpts, 'recursive' | 'ignore' | 'onLimit' | 'onSkip'> & {
    log?: (message: string, error?: unknown) => void;
  },
  onEvent: (event: string, filename: string | null) => void,
): DirWatch {
  let watch: DirWatch | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let unwatched = false;
  let logged = false;
  const fail = (message: string, err: unknown) => {
    if (!logged) opts.log?.(message, err);
    logged = true;
    awaitDir();
  };
  const present = () => {
    if (fs.existsSync(dir)) return true;
    logged = false;
    return false;
  };
  const awaitDir = () => {
    if (closed || poll) return;
    unwatched = true;
    poll = setInterval(() => {
      if (!present()) return;
      if (poll) clearInterval(poll);
      poll = null;
      arm();
    }, EXISTS_POLL_MS);
  };
  const arm = () => {
    if (!present()) return awaitDir();
    try {
      watch = watchDir(
        dir,
        {
          recursive: opts.recursive,
          ignore: opts.ignore,
          onLimit: opts.onLimit,
          onSkip: opts.onSkip,
        },
        onEvent,
        (err) => {
          watch = null;
          if (err) return fail('watch error', err);
          awaitDir();
        },
      );
    } catch (err) {
      return fail('could not watch', err);
    }
    if (!unwatched) return;
    unwatched = false;
    onEvent('rename', null);
  };
  arm();
  return {
    close() {
      closed = true;
      if (poll) clearInterval(poll);
      poll = null;
      watch?.close();
      watch = null;
    },
  };
}
