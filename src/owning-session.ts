/**
 * Resolve the "best" session to open a file in, given:
 *  - open docs (for already-open detection)
 *  - session project roots (for nearest-ancestor matching)
 *  - the currently active session (fallback)
 *
 * Rule order:
 *  1. If any session already has `path` open as a doc, return that session's id.
 *     If multiple sessions have it open, prefer the active one; otherwise the first.
 *  2. Else: the session whose `projectPath` is the longest ancestor-prefix of `path`.
 *     "Ancestor" is segment-aware: /foo/bar IS an ancestor of /foo/bar/baz.ts but NOT
 *     of /foo/barbaz (no false prefix match).
 *  3. Else: `activeId`.
 */
export function resolveOwningSession(input: {
  path: string;
  sessions: { id: string; projectPath: string }[];
  openDocs: { sessionId: string; path: string }[];
  activeId: string | null;
}): string | null {
  const { path, sessions, openDocs, activeId } = input;
  const normPath = normalizePath(path);

  // Rule 1: already open in a session
  const openInSessions = openDocs
    .filter((d) => normalizePath(d.path) === normPath)
    .map((d) => d.sessionId);

  if (openInSessions.length > 0) {
    // Prefer the active session if it has it open
    if (activeId && openInSessions.includes(activeId)) return activeId;
    return openInSessions[0];
  }

  // Rule 2: nearest ancestor (longest segment-aware prefix)
  let bestId: string | null = null;
  let bestLen = -1;

  for (const session of sessions) {
    const normRoot = normalizePath(session.projectPath);
    if (!isAncestorOf(normRoot, normPath)) continue;
    if (normRoot.length > bestLen) {
      bestLen = normRoot.length;
      bestId = session.id;
    }
  }

  if (bestId !== null) return bestId;

  // Rule 3: fallback to active
  return activeId;
}

/** Normalize path separators to forward-slash and strip trailing slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Returns true iff `root` is a proper ancestor of `child` (or equal to it),
 * using segment-aware prefix matching.
 *
 * `/foo/bar` IS an ancestor of `/foo/bar/baz` and `/foo/bar` itself.
 * `/foo/bar` is NOT an ancestor of `/foo/barbaz`.
 */
function isAncestorOf(root: string, child: string): boolean {
  if (root === child) return true;
  return child.startsWith(`${root}/`);
}
