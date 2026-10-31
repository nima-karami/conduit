// see spec 2026-10-30-conduit-mcp-app-control §2.1 "Focus" and A4
import { flushSync } from 'react-dom';

/**
 * Runs a tool-driven open and commits it before returning. True when the element that held DOM
 * focus sat inside `panes` (the caller's own panes; null when the caller isn't on screen) and the
 * open hid or removed it: the keyboard is then nowhere, and the caller should land it in the
 * opened view. Chromium may still report a hidden element as active until its next focus fixup,
 * so hidden counts the same as body.
 */
export function openHidesFocus(panes: Element | null, open: () => void): boolean {
  const before = document.activeElement;
  const owned =
    panes !== null && before !== null && before !== document.body && panes.contains(before);
  flushSync(open);
  if (!owned) return false;
  const now = document.activeElement;
  return now === null || now === document.body || !now.isConnected || !now.checkVisibility();
}
