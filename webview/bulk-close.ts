/**
 * Pure selection logic for the bulk session-close actions (J4): decide WHICH
 * session ids to close; the caller drives the existing single-close teardown per
 * id. Input order is preserved for deterministic teardown.
 *
 * See docs/specs/archive/2026-06-11-close-all-others.md.
 */

/** All session ids — the targets for "Close all sessions". */
export function closeAllIds(sessionIds: readonly string[]): string[] {
  return [...sessionIds];
}

/** Every session id except `targetId` (the one invoked on, which stays open). */
export function closeOthersIds(sessionIds: readonly string[], targetId: string): string[] {
  return sessionIds.filter((id) => id !== targetId);
}
