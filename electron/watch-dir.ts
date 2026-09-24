import * as fs from 'node:fs';
import { folderKey } from '../src/folder-key';

export type WatchFn = (
  dir: string,
  opts: { recursive?: boolean },
  cb: (event: string, filename: string | Buffer | null) => void,
) => fs.FSWatcher;

export interface DirWatch {
  close(): void;
}

const LONG_PATH = /^\\\\\?\\(UNC\\)?/i;

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
    if (name !== null && namesWatchedDir(dir, name)) return gone();
    onEvent(event, name);
  });
  watcher.on('error', (e) => gone(e));
  return { close };
}
