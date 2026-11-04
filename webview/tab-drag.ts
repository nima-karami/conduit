import type { GroupIndex } from './doc-groups';
import type { OpenDoc } from './docs';
import { TERMINAL_PATH_MIME } from './terminal-drop';

/** Stamped at a tab's dragstart; only a drag carrying it is a tab move (an OS file or explorer
 *  row drag never is, whatever the module state says). */
export const TAB_DRAG_MIME = 'application/x-conduit-tab';

/** A doc tab being dragged; module-level so every strip and group body can see it. */
export interface TabDrag {
  id: string;
  group: GroupIndex;
  /** What a drop on a terminal pastes; null for a tab that isn't one real file. */
  terminalPath: string | null;
}

/** Only a file tab names one unambiguous file: a diff's file may be deleted or not the working
 *  tree's, and the other kinds aren't files at all. */
export function tabTerminalPath(doc: Pick<OpenDoc, 'kind' | 'path'>): string | null {
  return doc.kind === 'file' ? doc.path : null;
}

/** The share of a group body, from its right edge, where dropping one of that group's own tabs
 *  splits it into a new group (split-editor spec §2.4 flow 4). */
export const EDGE_ZONE_FRACTION = 1 / 3;

/** Where group `g`'s drop overlay takes a tab drag: its whole body, only the edge split zone, or
 *  nowhere. Over a shown terminal a path-carrying drag is the terminal's (it pastes the path), so
 *  the overlay keeps only the edge split, which the terminal has no meaning for. */
export function dropHitZone(
  drag: TabDrag,
  g: GroupIndex,
  split: boolean,
  terminalShown: boolean,
): 'body' | 'edge' | 'none' {
  if (!terminalShown || drag.terminalPath === null) return 'body';
  return drag.group === g && !split ? 'edge' : 'none';
}

let current: TabDrag | null = null;
const listeners = new Set<() => void>();

function set(next: TabDrag | null): void {
  current = next;
  for (const fn of listeners) fn();
}

export function beginTabDrag(d: TabDrag, dt: DataTransfer): void {
  dt.setData(TAB_DRAG_MIME, d.id);
  if (d.terminalPath !== null) dt.setData(TERMINAL_PATH_MIME, d.terminalPath);
  set({ id: d.id, group: d.group, terminalPath: d.terminalPath });
  // No target handler sees a drop into a <webview> or outside the window; the window still does.
  window.addEventListener('dragend', endTabDrag);
  window.addEventListener('drop', endTabDrag);
}

export function currentTabDrag(): TabDrag | null {
  return current;
}

/** The live tab drag `e` carries, or null for any other drag. */
export function tabDragOf(e: { dataTransfer: DataTransfer | null }): TabDrag | null {
  return current !== null && e.dataTransfer?.types.includes(TAB_DRAG_MIME) ? current : null;
}

export function endTabDrag(): void {
  window.removeEventListener('dragend', endTabDrag);
  window.removeEventListener('drop', endTabDrag);
  if (current !== null) set(null);
}

/** Accepts a tab drop over the current target. Ctrl requests the duplicate, but a tab dragged as
 *  move-only must still drop, so the effect is always one its drag allows. */
export function acceptTabDrop(e: {
  preventDefault(): void;
  ctrlKey: boolean;
  dataTransfer: DataTransfer | null;
}): void {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect =
      e.ctrlKey && e.dataTransfer.effectAllowed === 'copyMove' ? 'copy' : 'move';
  }
}

export function subscribeTabDrag(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
