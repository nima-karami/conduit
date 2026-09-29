import type { GroupIndex } from './doc-groups';

/** A doc tab being dragged; module-level so every strip and group body can see it. */
export interface TabDrag {
  id: string;
  group: GroupIndex;
  sessionId: string;
}

let current: TabDrag | null = null;
const listeners = new Set<() => void>();

function set(next: TabDrag | null): void {
  current = next;
  for (const fn of listeners) fn();
}

export function beginTabDrag(d: TabDrag): void {
  set({ id: d.id, group: d.group, sessionId: d.sessionId });
}

export function currentTabDrag(): TabDrag | null {
  return current;
}

export function endTabDrag(): void {
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
