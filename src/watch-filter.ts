// Which filesystem-watch events are worth reacting to. A recursive watch on a project
// root sees everything — build output, dependency churn, git's internal object/lock writes
// — most of which should NOT trigger a git-status + tree refresh. This pure predicate is
// the single source of truth for that filtering (modeled on VS Code's files.watcherExclude
// plus the git extension's DotGitWatcher noise filters).

/** Directory names whose entire subtree is ignored (heavy/derived, never user-meaningful). */
const IGNORED_DIR_SEGMENTS = new Set([
  'node_modules',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '.nyc_output',
]);

/**
 * True when a change at `rel` (a path RELATIVE to the watched root, either separator) should
 * be ignored. Returns false (i.e. "react to it") for an empty/unknown filename — better to
 * refresh once spuriously than miss a real change.
 *
 * `.git` is special: branch/commit/rebase/merge all land on `.git/HEAD`, `.git/index`, or
 * `.git/refs/**`, so those MUST pass through; but `.git/objects`, `.git/logs`, `*.lock`, and
 * watchman cookies are pure churn and are dropped.
 */
export function shouldIgnoreWatchPath(rel: string): boolean {
  if (!rel) return false;
  const segs = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1] ?? '';

  if (segs[0] === '.git') {
    if (segs[1] === 'objects' || segs[1] === 'logs') return true;
    if (last.endsWith('.lock') || last.includes('.watchman-cookie-')) return true;
    return false; // HEAD, index, refs/**, MERGE_HEAD, … are meaningful
  }

  if (segs.some((s) => IGNORED_DIR_SEGMENTS.has(s))) return true;

  // Editor swap/temp churn.
  if (last.endsWith('~') || last.endsWith('.swp') || last.endsWith('.tmp')) return true;

  return false;
}
