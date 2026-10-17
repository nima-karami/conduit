/**
 * The repo root last picked from a terminal path picker, per session: a ranking signal that
 * survives a pane remount but not a restart (spec 2026-10-16-terminal-path-links §3.3,
 * runtime-only).
 */
const picks = new Map<string, string>();

export function notePick(sessionId: string, repoRoot: string): void {
  picks.set(sessionId, repoRoot);
}

export function lastPick(sessionId: string): string | undefined {
  return picks.get(sessionId);
}
