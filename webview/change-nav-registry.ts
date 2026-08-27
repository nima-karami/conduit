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

export function changeNavForActiveDoc(
  docs: readonly { id: string; path: string }[],
  activeId: string | null,
): ChangeNavEntry | undefined {
  const path = activeDocPath(docs, activeId);
  return path === null ? undefined : registry.get(path);
}
