/**
 * Repo-relative path resolution, node-free so BOTH the host and the renderer can use it.
 * `src/path-guard.ts`'s isInsideRoot is the write-guard's backbone but pulls node:fs and
 * branches on process.platform — the renderer can't import it, and a platform branch goes
 * red on CI's ubuntu (CLAUDE.md). Case-sensitivity is derived from the ROOT's shape instead:
 * a drive-letter prefix means a Windows filesystem, wherever the code happens to run.
 */

const toPosix = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

const isWindowsRoot = (root: string): boolean => /^[a-zA-Z]:\//.test(root);

/**
 * `absPath` expressed relative to `root`, with forward slashes — the form git wants for
 * `HEAD:<rel>`. Null when the path is the root itself, escapes it, or lives elsewhere.
 */
export function repoRelPath(root: string, absPath: string): string | null {
  const r = toPosix(root);
  const p = toPosix(absPath);
  if (!r || !p) return null;
  const fold = isWindowsRoot(r) ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (fold(p) === fold(r)) return null;
  if (!fold(p).startsWith(`${fold(r)}/`)) return null;
  const rel = p.slice(r.length + 1);
  if (!rel || rel.split('/').includes('..')) return null;
  return rel;
}

/** True when `absPath` names a file nested under `root`. */
export function isUnderRoot(root: string, absPath: string): boolean {
  return repoRelPath(root, absPath) !== null;
}
