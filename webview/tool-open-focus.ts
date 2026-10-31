// see spec 2026-10-30-conduit-mcp-app-control §2.1 "Focus" and A4
import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { type GroupIndex, layoutOf, openTargetGroup } from './doc-groups';
import type { DocsState, OpenDoc } from './docs';

/**
 * Runs a tool-driven open and commits it before returning. True when the element that held DOM
 * focus sat inside one of `panes` (the surfaces the caller owns on screen; empty when the caller
 * isn't shown) and the open hid or removed it: the keyboard is then nowhere, and the caller
 * should land it in the opened view. Chromium may still report a hidden element as active until
 * its next focus fixup, so hidden counts the same as body.
 */
export function openHidesFocus(panes: readonly Element[], open: () => void): boolean {
  const before = document.activeElement;
  const owned =
    before !== null && before !== document.body && panes.some((p) => p.contains(before));
  flushSync(open);
  if (!owned) return false;
  const now = document.activeElement;
  return now === null || now === document.body || !now.isConnected || !now.checkVisibility();
}

/**
 * Runs `drain` after each commit that changes it, but outside React's commit: inside a passive
 * effect `flushSync` can't commit, so an openHidesFocus there would sample focus before the open
 * rendered.
 */
export function useDrainAfterCommit(drain: () => void): void {
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (live) drain();
    });
    return () => {
      live = false;
    };
  }, [drain]);
}

/**
 * A tool's open into `sessionId`, handed the group it opens into. The doc to land focus on when
 * the open hid the keyboard: that group's active tab, if it is the opened doc. The group is fixed
 * before the open, since afterwards the other group of a split may show a match too.
 */
export function runToolOpen(
  state: () => DocsState,
  sessionId: string,
  panes: readonly Element[],
  opened: (d: OpenDoc) => boolean,
  open: (group: GroupIndex) => void,
): { group: GroupIndex; id: string } | null {
  const g = openTargetGroup(state(), sessionId);
  if (!openHidesFocus(panes, () => open(g))) return null;
  const after = state();
  const id = layoutOf(after, sessionId).groups[g - 1]?.active ?? null;
  const d = after.docs.find((x) => x.id === id);
  return id !== null && d !== undefined && opened(d) ? { group: g, id } : null;
}
