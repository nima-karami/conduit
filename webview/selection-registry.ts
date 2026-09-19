/**
 * Selection registry — the same shape and the same reason as save-registry / change-nav-registry:
 * the Mod+Shift+F handler lives in app.tsx and has no handle on the active editor, so each
 * readable surface registers a synchronous selection reader under its doc PATH.
 */

import { activeDocPath } from './save-registry';

export interface SelectionEntry {
  /** The text selected in this surface RIGHT NOW; '' when nothing is selected. */
  getSelectedText(): string;
}

const registry = new Map<string, SelectionEntry>();

/** Register `entry` for `path`; the returned teardown is identity-checked so a remount that
 *  already replaced the entry can't have it deleted out from under it. */
export function registerSelection(path: string, entry: SelectionEntry): () => void {
  registry.set(path, entry);
  return () => {
    if (registry.get(path) === entry) registry.delete(path);
  };
}

/** The active doc's selected text, or '' when the Terminal tab is active, no doc matches,
 *  or the active doc registered no reader. */
export function selectionInActiveDoc(
  docs: readonly { id: string; path: string }[],
  activeId: string | null,
): string {
  const path = activeDocPath(docs, activeId);
  return path === null ? '' : (registry.get(path)?.getSelectedText() ?? '');
}
