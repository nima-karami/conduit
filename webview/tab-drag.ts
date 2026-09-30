import type { GroupIndex } from './doc-groups';

/** Stamped at a tab's dragstart; only a drag carrying it is a tab move (an OS file or explorer
 *  row drag never is, whatever the module state says). */
export const TAB_DRAG_MIME = 'application/x-conduit-tab';

/** A doc tab being dragged; module-level so every strip and group body can see it. */
export interface TabDrag {
  id: string;
  group: GroupIndex;
}

let current: TabDrag | null = null;
const listeners = new Set<() => void>();

function set(next: TabDrag | null): void {
  current = next;
  for (const fn of listeners) fn();
}

export function beginTabDrag(d: TabDrag, dt: DataTransfer): void {
  dt.setData(TAB_DRAG_MIME, d.id);
  set({ id: d.id, group: d.group });
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
