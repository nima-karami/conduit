/**
 * Scrollback file naming + orphan detection (stale-session hygiene).
 *
 * One file per terminal session: `scrollback-<sanitized-id>.json` in userData (T2).
 * The id is sanitized so a stray path separator can't escape the directory — the same
 * transform must be used for both writing and orphan-matching, so it lives here as the
 * single source of truth (host `scrollbackFile()` builds on it).
 */

const SANITIZE = /[^\w.-]/g;
const SCROLLBACK_FILE = /^scrollback-.*\.json$/;

export function scrollbackFileName(sessionId: string): string {
  return `scrollback-${sessionId.replace(SANITIZE, '_')}.json`;
}

/**
 * Given the filenames present in userData and the ids of the live/restored sessions,
 * return the scrollback filenames that belong to no live session — safe to delete.
 * Non-scrollback filenames are ignored. Conservative on collisions: a file whose name
 * matches any live id's sanitized name is kept.
 */
export function orphanScrollbackFiles(
  existingFilenames: readonly string[],
  liveIds: readonly string[],
): string[] {
  const keep = new Set(liveIds.map(scrollbackFileName));
  return existingFilenames.filter((name) => SCROLLBACK_FILE.test(name) && !keep.has(name));
}
