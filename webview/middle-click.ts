import type { MouseEventHandler } from 'react';
import type { BackgroundOutcome } from './docs';

export function isMiddleButton(e: { button: number }): boolean {
  return e.button === 1;
}

// A middle mousedown left alone starts Windows autoscroll (which swallows the auxclick) and moves
// focus; spec 2026-09-22-middle-click-new-tab C2–C4.
function suppressMiddleMouseDown(e: { button: number; preventDefault(): void }): void {
  if (isMiddleButton(e)) e.preventDefault();
}

interface MiddleClickProps<T extends Element> {
  onMouseDown: MouseEventHandler<T>;
  onAuxClick: MouseEventHandler<T>;
}

/**
 * Spread on the ITEM element, never a container: an auxclick whose down and up landed on
 * different items fires on their common ancestor (spec C7). `onMiddle: null` swallows the gesture
 * on an item that has no middle action (a folder, a collapse head). Mousedown is never stopped —
 * the menus' outside-click dismissal listens for it.
 */
export function middleClickProps<T extends Element = Element>(
  onMiddle: (() => void) | null,
  onMouseDown?: MouseEventHandler<T>,
): MiddleClickProps<T> {
  return {
    onMouseDown: (e) => {
      onMouseDown?.(e);
      suppressMiddleMouseDown(e);
    },
    onAuxClick: (e) => {
      if (!isMiddleButton(e)) return;
      // Also stops the host's own background-tab open for an <a href> (spec C5).
      e.preventDefault();
      e.stopPropagation();
      onMiddle?.();
    },
  };
}

export type TerminalLinkMiddleAction = 'foreground' | 'background' | 'ignore';

/** xterm activates a link on mouseup of ANY button; on Linux middle is primary-selection paste,
 *  so it never opens there (spec D3). `platform` is `navigator.platform`. */
export function terminalLinkMiddleAction(
  button: number,
  platform: string,
): TerminalLinkMiddleAction {
  if (button === 0) return 'foreground';
  if (button === 1) return /linux/i.test(platform) ? 'ignore' : 'background';
  return 'ignore';
}

export const MIDDLE_CLICK_STRINGS = {
  opened: (title: string) => `Opened ${title} in a background tab`,
  openedIn: (title: string, session: string) => `Opened ${title} in a background tab in ${session}`,
  pinned: (title: string) => `Pinned ${title}`,
  pinnedIn: (title: string, session: string) => `Pinned ${title} in ${session}`,
  alreadyOpen: (title: string) => `${title} is already open`,
  alreadyOpenIn: (title: string, session: string) => `${title} is already open in ${session}`,
};

export function backgroundOpenAnnouncement(
  outcome: BackgroundOutcome,
  title: string,
  sessionName: string | null,
): string {
  const s = MIDDLE_CLICK_STRINGS;
  switch (outcome) {
    case 'opened':
      return sessionName === null ? s.opened(title) : s.openedIn(title, sessionName);
    case 'pinned':
      return sessionName === null ? s.pinned(title) : s.pinnedIn(title, sessionName);
    case 'already-open':
      return sessionName === null ? s.alreadyOpen(title) : s.alreadyOpenIn(title, sessionName);
  }
}
