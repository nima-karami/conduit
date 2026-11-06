// Pure comparison primitives for the host's `.conduit/` watchers, factored out of the FS
// plumbing (electron/board-watcher.ts, electron/notes-watcher.ts) so they are unit-testable
// without Electron. See docs/specs/archive/2026-06-11-conduit-board.md.

import type { BoardData } from './board';

/**
 * A content fingerprint of a board's *card payload only* — deliberately NOT the envelope
 * `updatedAt`. The board watcher keeps the fingerprint of the board the renderer holds (the
 * one sent at open, the app's own save, the last emit); a re-read that matches it is no
 * change and is not emitted. Ignoring the provenance timestamp keeps a recorded save's
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
