import * as fs from 'node:fs';
import * as path from 'node:path';
import { folderKey } from '../src/folder-key';

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

/**
 * `fs.watch` on a directory that cannot outlive it: the directory vanishing, or the watch
 * erroring, closes the watch and calls `onGone` exactly once (`error` is undefined for a
 * vanish). What "gone" means — drop, mark missing, re-arm later — is the caller's decision.
 * Throws whatever `fs.watch` throws when the watch cannot be opened.
 */
export function watchDir(
  dir: string,
  opts: { recursive?: boolean; watch?: WatchFn },
  onEvent: (event: string, filename: string | null) => void,
  onGone: (error?: Error) => void,
): DirWatch {
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

/**
 * A `watchDir` for a directory that may not exist yet, or may be deleted and recreated (a branch
 * switch): while it is missing — at start, after a vanish, or after an 'error' — it is looked for
 * every `EXISTS_POLL_MS` and watched again once it is back. Never creates the directory and never
 * throws. What changed while it was unwatched is not replayed per file: an arm that ends a missing
 * phase emits one `('rename', null)` instead, so the caller re-reads everything — a checkout, or a
 * `mkdir -p` and write, lands the content before the poll arms.
 */
export function watchDirWhilePresent(
  dir: string,
  opts: { recursive?: boolean; log?: (message: string, error?: unknown) => void },
  onEvent: (event: string, filename: string | null) => void,
): DirWatch {
  let watch: DirWatch | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let unwatched = false;
  const awaitDir = () => {
    if (closed || poll) return;
    unwatched = true;
    poll = setInterval(() => {
      if (!fs.existsSync(dir)) return;
      if (poll) clearInterval(poll);
      poll = null;
      arm();
    }, EXISTS_POLL_MS);
  };
  const arm = () => {
    if (!fs.existsSync(dir)) return awaitDir();
    try {
      watch = watchDir(dir, { recursive: opts.recursive }, onEvent, (err) => {
        watch = null;
        if (err) opts.log?.('watch error', err);
        awaitDir();
      });
    } catch (err) {
      opts.log?.('could not watch', err);
      return awaitDir();
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
