// Pure loop-avoidance for the live board watcher. Factored out of the host FS plumbing
// (electron/board-watcher.ts) so the "is this the app's own write echoing back?"
// decision is unit-testable without Electron. See docs/specs/conduit-board.md.

import type { BoardData } from './board';

/**
 * A content fingerprint of a board's *card payload only* — deliberately NOT the envelope
 * `updatedAt`. The host records the fingerprint of a board it just saved; when the FS
 * watcher fires and re-reads the file, a matching fingerprint means the change is the
 * app's own write echoing back (suppress it), and a different fingerprint means a genuine
 * external edit (emit it). Ignoring the provenance timestamp keeps the recorded
 * fingerprint matching the on-disk file even though each write stamps a fresh `updatedAt`.
 */
export function fingerprint(board: BoardData): string {
  return JSON.stringify(board.cards);
}

/**
 * True when the freshly-read `current` fingerprint equals the `lastWritten` fingerprint
 * the host recorded for its own most recent save — i.e. the watch event is the app's own
 * write echoing back and should be ignored. False when they differ (a real external
 * change) or when we have never written (`lastWritten` undefined → any content is
 * external and worth emitting).
 */
export function isSelfEcho(lastWritten: string | undefined, current: string): boolean {
  return lastWritten !== undefined && lastWritten === current;
}
