/**
 * Repo-relative path resolution, node-free so BOTH the host and the renderer can use it.
 * `src/path-guard.ts`'s isInsideRoot is the write-guard's backbone but pulls node:fs and
 * branches on process.platform — the renderer can't import it, and a platform branch goes
 * red on CI's ubuntu (CLAUDE.md). Case-sensitivity is derived from the ROOT's shape instead:
 * a drive-letter prefix means a Windows filesystem, wherever the code happens to run.
 */

const toPosix = (p: string): string => p.replace(/\\/g, '/');

const trimTrailingSlashes = (p: string): string => p.replace(/\/+$/, '');

// The prefix keeps the root's own separator: a drive root `C:\` must stay `C:/` (so the
// drive-letter check sees it) and a filesystem root `/` must stay `/` (not collapse to '').
const rootPrefix = (root: string): string => `${trimTrailingSlashes(toPosix(root))}/`;

const isWindowsPrefix = (prefix: string): boolean => /^[a-zA-Z]:\//.test(prefix);

/**
 * Case fold for comparing repo-relative paths, by the same rule repoRelPath uses for
 * containment: Windows paths are case-insensitive, so two spellings of one file must compare
 * equal. A set built with this and queried without it silently misses — which is how a file
 * with a staged side got Stage offered on it anyway.
 */
export function foldRelPath(root: string, rel: string): string {
  return isWindowsPrefix(rootPrefix(root)) ? rel.toLowerCase() : rel;
}

/**
 * `absPath` expressed relative to `root`, with forward slashes — the form git wants for
 * `HEAD:<rel>`. Null when the path is the root itself, escapes it, or lives elsewhere.
 */
export function repoRelPath(root: string, absPath: string): string | null {
  if (!toPosix(root)) return null;
  const p = trimTrailingSlashes(toPosix(absPath));
  const prefix = rootPrefix(root);
  const fold = isWindowsPrefix(prefix) ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (!p || !fold(p).startsWith(fold(prefix))) return null;
  const rel = p.slice(prefix.length);
  if (!rel || rel.split('/').includes('..')) return null;
  return rel;
}

/** True when `absPath` names a file nested under `root`. */
export function isUnderRoot(root: string, absPath: string): boolean {
  return repoRelPath(root, absPath) !== null;
}
