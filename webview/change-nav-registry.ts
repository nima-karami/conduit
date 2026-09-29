import type { GroupIndex } from './doc-groups';
import { createPathRegistry } from './path-registry';
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

const registry = createPathRegistry<ChangeNavEntry>();

export function registerChangeNav(
  path: string,
  entry: ChangeNavEntry,
  group: GroupIndex = 1,
): () => void {
  return registry.register(path, entry, group);
}

function changeNavForActiveDoc(
  docs: readonly { id: string; path: string }[],
  activeId: string | null,
  group: GroupIndex,
): ChangeNavEntry | undefined {
  const path = activeDocPath(docs, activeId);
  return path === null ? undefined : registry.get(path, group);
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
  group: GroupIndex = 1,
): void {
  const entry = changeNavForActiveDoc(docs, activeId, group);
  if (!entry) return;
  if (direction === 'next') entry.next();
  else entry.prev();
}
