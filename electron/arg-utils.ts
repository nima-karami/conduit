export type OpenTarget = { kind: 'dir' | 'file'; path: string };

/** Skip the launcher itself: on a packaged build it also classifies as an existing file. */
export function extractOpenTargets(
  argv: readonly string[],
  classify: (p: string) => 'dir' | 'file' | 'none',
  skip: readonly string[] = [],
): OpenTarget[] {
  const skipSet = new Set(skip);
  const targets: OpenTarget[] = [];
  for (const arg of argv) {
    if (!arg || arg === '.' || arg.startsWith('-') || skipSet.has(arg)) continue;
    const kind = classify(arg);
    if (kind === 'dir' || kind === 'file') targets.push({ kind, path: arg });
  }
  return targets;
}

export function extractOpenTarget(
  argv: readonly string[],
  classify: (p: string) => 'dir' | 'file' | 'none',
  skip: readonly string[] = [],
): OpenTarget | undefined {
  return extractOpenTargets(argv, classify, skip)[0];
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
