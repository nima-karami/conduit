export type OpenTarget = { kind: 'dir' | 'file'; path: string };

/**
 * First argv entry that classifies as an existing dir or file. The OS launch actions
 * invoke `Conduit.exe "<path>"`, so on launch (or via the single-instance `second-instance`
 * event) we scan argv for the target to open. Skips the executable path (classifies as
 * 'none' — it is not one of the user's chosen targets in practice), the Electron dev `.`
 * arg, and any `--flags`. Returns the first remaining entry `classify` accepts, else
 * `undefined`.
 *
 * `classify` is injected so this stays pure and unit-testable without touching the filesystem.
 */
export function extractOpenTarget(
  argv: readonly string[],
  classify: (p: string) => 'dir' | 'file' | 'none',
): OpenTarget | undefined {
  for (const arg of argv) {
    if (!arg || arg === '.' || arg.startsWith('-')) continue;
    const kind = classify(arg);
    if (kind === 'dir' || kind === 'file') return { kind, path: arg };
  }
  return undefined;
}

/**
 * Back-compat wrapper over {@link extractOpenTarget}: returns the first directory argument
 * (or undefined). Existing callers/tests of the folder-launch path use this unchanged.
 */
export function extractDirArg(
  argv: readonly string[],
  isDir: (p: string) => boolean,
): string | undefined {
  const target = extractOpenTarget(argv, (p) => (isDir(p) ? 'dir' : 'none'));
  return target?.kind === 'dir' ? target.path : undefined;
}

/**
 * Walk up from a file's directory to the nearest ancestor that contains a `.git` entry,
 * returning that ancestor (the git root), or `undefined` if none is found. Used to root a
 * lone file's session at its repo (else the caller falls back to the file's parent dir).
 *
 * Separator-agnostic (handles both `/` and `\\`) so it is correct regardless of the host
 * OS the unit tests run on. `exists` is injected for pure, fs-free testing.
 */
export function gitRootOf(file: string, exists: (p: string) => boolean): string | undefined {
  const sep = file.includes('\\') ? '\\' : '/';
  // Drop the final segment (the file name) to start at its containing directory.
  let dir = trimTrailingSep(file.slice(0, lastSepIndex(file)), sep);
  while (dir) {
    if (exists(`${dir}${sep}.git`)) return dir;
    const idx = lastSepIndex(dir);
    if (idx <= 0) break; // reached a root segment (drive root or leading slash)
    dir = trimTrailingSep(dir.slice(0, idx), sep);
  }
  return undefined;
}

function lastSepIndex(p: string): number {
  return Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
}

function trimTrailingSep(p: string, sep: string): string {
  return p.endsWith(sep) ? p.slice(0, -sep.length) : p;
}
