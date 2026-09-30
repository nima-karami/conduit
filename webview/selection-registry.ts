/**
 * Selection registry — the same shape and the same reason as save-registry / change-nav-registry:
 * the Mod+Shift+F handler lives in app.tsx and has no handle on the active editor, so each
 * readable surface registers a synchronous selection reader under its doc PATH.
 */

import type { GroupIndex } from './doc-groups';
import { createPathRegistry } from './path-registry';
import { activeDocPath } from './save-registry';

export interface SelectionEntry {
  /** The text selected in this surface RIGHT NOW; '' when nothing is selected. */
  getSelectedText(): string;
}

const registry = createPathRegistry<SelectionEntry>();

export function registerSelection(
  path: string,
  entry: SelectionEntry,
  group: GroupIndex = 1,
): () => void {
  return registry.register(path, entry, group);
}

/** The active doc's selected text, or '' when the Terminal tab is active, no doc matches,
 *  or the active doc registered no reader. */
export function selectionInActiveDoc(
  docs: readonly { id: string; path: string }[],
  activeId: string | null,
  group: GroupIndex = 1,
): string {
  const path = activeDocPath(docs, activeId);
  return path === null ? '' : (registry.get(path, group)?.getSelectedText() ?? '');
}
