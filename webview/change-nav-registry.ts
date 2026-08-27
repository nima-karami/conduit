import { activeDocPath } from './save-registry';

/**
 * Change-navigation registry — the same shape as save-registry, and for the same reason: the
 * command palette lives in app.tsx and has no handle on the active editor, so the CodeViewer
 * registers its own next/prev under its doc PATH and the palette routes through here.
 */
export interface ChangeNavEntry {
  next(): void;
  prev(): void;
  hasChanges(): boolean;
}

const registry = new Map<string, ChangeNavEntry>();

/** Register `entry` for `path`; the returned teardown is identity-checked so a remount that
 *  already replaced the entry can't have it deleted out from under it. */
export function registerChangeNav(path: string, entry: ChangeNavEntry): () => void {
  registry.set(path, entry);
  return () => {
    if (registry.get(path) === entry) registry.delete(path);
  };
}

function changeNavForActiveDoc(
  docs: readonly { id: string; path: string }[],
  activeId: string | null,
): ChangeNavEntry | undefined {
  const path = activeDocPath(docs, activeId);
  return path === null ? undefined : registry.get(path);
}

/**
 * Route next/previous-change to the active doc's editor. Self-guarded exactly like
 * saveActiveDoc: a no-op when the Terminal tab is active or the active doc registered no
 * entry, so callers never have to ask first — and the editor itself owns the "No changes"
 * announcement, which is why an empty file still reaches this.
 */
export function goToChangeInActiveDoc(
  docs: readonly { id: string; path: string }[],
  activeId: string | null,
  direction: 'next' | 'prev',
): void {
  const entry = changeNavForActiveDoc(docs, activeId);
  if (!entry) return;
  if (direction === 'next') entry.next();
  else entry.prev();
}
