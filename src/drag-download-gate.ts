import { folderKey } from './folder-key';

/** A drag-download fires when the drop target asks for the bytes, i.e. at drop, so a grant must
 *  outlive a slow drag; it must not outlive the gesture by much, or a page could bank it. */
export const DRAG_DOWNLOAD_TTL_MS = 60_000;

/**
 * The host's record of which file each app window just started dragging out, so `will-download`
 * admits only that drop (os-drag-out plan Slice 5; the same shape as createGuestOpenGate in
 * src/webview-guard.ts). One grant per window, spent by the first matching download. Paths are
 * the caller's realpaths; nothing here touches the filesystem.
 */
export function createDragDownloadGate(opts: { caseInsensitive: boolean }): {
  arm(windowId: number, realPath: string, now: number): void;
  claim(windowId: number, realPath: string, now: number): boolean;
} {
  const grants = new Map<number, { key: string; at: number }>();
  const keyOf = (p: string) => (opts.caseInsensitive ? folderKey(p).toLowerCase() : folderKey(p));
  return {
    arm(windowId, realPath, now) {
      grants.set(windowId, { key: keyOf(realPath), at: now });
    },
    claim(windowId, realPath, now) {
      const g = grants.get(windowId);
      if (!g || now - g.at > DRAG_DOWNLOAD_TTL_MS) return false;
      // A mismatch is left armed: an unrelated download must not cancel the user's drop.
      if (g.key !== keyOf(realPath)) return false;
      grants.delete(windowId);
      return true;
    },
  };
}
