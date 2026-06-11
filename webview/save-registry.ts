/**
 * Save registry (K2 — save reliability). Mirrors the dirty-store pattern: a tiny
 * external store keyed by doc PATH. The CodeViewer owns the Monaco model and the
 * on-disk baseline, so it owns the save action; it registers that action here on
 * mount and unregisters on unmount. The global Mod+S handler (app.tsx) then routes a
 * keypress — from ANYWHERE, including the terminal or the sidebar — to the ACTIVE
 * doc's registered save, fixing the "Ctrl+S does nothing outside the editor" bug.
 *
 * The entry is an OBJECT (`{ save() }`) rather than a bare function so future verbs
 * (revert, save-as) can be added without a breaking change.
 *
 * Keyed by PATH (matching dirty-store.ts and the `file:${path}` doc-tab ids).
 *
 * K3 — fresh-file-content: a saved-content notification channel sits alongside the
 * save registry. After CodeViewer writes to disk it calls notifySaved(path, content),
 * which propagates the saved content to any registered listeners (e.g. app.tsx updates
 * its `files` map so the markdown rendered view reflects the new content immediately,
 * without waiting for a host round-trip).
 */

export interface SaveEntry {
  /** Persist the current buffer to disk. Idempotent + self-guarded (clean → no-op). */
  save(): void;
}

const registry = new Map<string, SaveEntry>();

// ----- K3: saved-content notification channel -----

type SavedListener = (path: string, content: string) => void;
const savedListeners = new Set<SavedListener>();

/**
 * Subscribe to successful saves. The callback receives the file path and the
 * exact content that was written to disk. Returns an unsubscribe function.
 */
export function onFileSaved(cb: SavedListener): () => void {
  savedListeners.add(cb);
  return () => savedListeners.delete(cb);
}

/**
 * Called by CodeViewer after a successful writeFile to push the saved content
 * to all listeners. This lets app.tsx update the `files` map immediately (no
 * host round-trip) so markdown viewers re-render with fresh content.
 */
export function notifySaved(path: string, content: string): void {
  savedListeners.forEach((cb) => {
    cb(path, content);
  });
}

/**
 * Register `entry` for `path`, returning an unregister fn. The unregister only drops
 * the entry it owns: if a remount replaced it in the meantime, the stale unregister is
 * a no-op (so React's mount-order — new effect runs before the old cleanup is NOT
 * guaranteed, but identity-checked teardown is safe either way).
 */
export function registerSave(path: string, entry: SaveEntry): () => void {
  registry.set(path, entry);
  return () => {
    if (registry.get(path) === entry) registry.delete(path);
  };
}

/** The save entry registered for `path`, or undefined. */
export function getSaveEntry(path: string): SaveEntry | undefined {
  return registry.get(path);
}

/** Minimal shape of an open doc — avoids importing the full docs type into tests. */
interface DocLike {
  id: string;
  path: string;
}

/**
 * Pure routing: the file path of the active tab, or null when the Terminal tab (null
 * id) is active or the active id matches no open doc. Unit-testable without React.
 */
export function activeDocPath(docs: readonly DocLike[], activeId: string | null): string | null {
  if (activeId === null) return null;
  return docs.find((d) => d.id === activeId)?.path ?? null;
}

/**
 * Invoke the active doc's registered save. No-op when the Terminal tab is active, the
 * active doc has no entry, or no doc is active. The save itself is self-guarded
 * (clean buffer / in-flight → no-op), so this is safe to call on every Mod+S.
 */
export function saveActiveDoc(docs: readonly DocLike[], activeId: string | null): void {
  const path = activeDocPath(docs, activeId);
  if (path === null) return;
  registry.get(path)?.save();
}

/** Invoke the save registered for an exact path (used by the dirty-tab affordance). */
export function saveDocByPath(path: string): void {
  registry.get(path)?.save();
}
