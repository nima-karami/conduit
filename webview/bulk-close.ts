/**
 * Pure selection logic for the bulk session-close actions (J4).
 *
 * "Close all" and "Close others" only need to decide WHICH session ids to close;
 * the actual teardown is the existing single-close path (the renderer posts a
 * `kill` per id, the host's PtyHost kills the pty and `SessionManager.remove`
 * drops it, then re-broadcasts `state`). Keeping the selection pure means it has
 * a single, unit-tested source of truth with no React/DOM/host dependency.
 *
 * Order is preserved from the input list so callers tear sessions down in a
 * deterministic order (useful for tests and stable host round-trips).
 *
 * See docs/specs/archive/2026-06-11-close-all-others.md.
 */

/** All session ids — the targets for "Close all sessions". */
export function closeAllIds(sessionIds: readonly string[]): string[] {
  return [...sessionIds];
}

/**
 * Every session id EXCEPT `targetId` — the targets for "Close others". The
 * target is the session the action was invoked on, which stays open. If the
 * target isn't in the list, every id is returned (nothing to keep). Empty in →
 * empty out.
 */
export function closeOthersIds(sessionIds: readonly string[], targetId: string): string[] {
  return sessionIds.filter((id) => id !== targetId);
}
