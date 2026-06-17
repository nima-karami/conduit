/**
 * Save registry (K2 — save reliability). A tiny external store keyed by doc PATH so the
 * global Mod+S handler (app.tsx) can route a keypress from ANYWHERE — terminal, sidebar —
 * to the ACTIVE doc's registered save, fixing "Ctrl+S does nothing outside the editor".
 * The CodeViewer owns the model/baseline so it registers on mount, unregisters on unmount.
 *
 * K3 — fresh-file-content: a saved-content notification channel (notifySaved) propagates
 * written content to listeners so app.tsx can update its `files` map and re-render the
 * markdown view immediately, without a host round-trip.
 */

export interface SaveEntry {
  /** Persist the current buffer to disk. Idempotent + self-guarded (clean → no-op).
   * Resolves true on success (or when already clean), false on failure. */
  save(): Promise<boolean>;
  /** Restore the on-disk baseline into the model, clearing dirty state.
   * Optional — not all doc types support revert (e.g. diff tabs). */
  revert?(): void;
}

const registry = new Map<string, SaveEntry>();

type SavedListener = (path: string, content: string) => void;
const savedListeners = new Set<SavedListener>();

/** Subscribe to successful saves; callback gets the path + exact written content. */
export function onFileSaved(cb: SavedListener): () => void {
  savedListeners.add(cb);
  return () => savedListeners.delete(cb);
}

/** Called by CodeViewer after a successful writeFile to push content to listeners. */
export function notifySaved(path: string, content: string): void {
  savedListeners.forEach((cb) => {
    cb(path, content);
  });
}

/**
 * Register `entry` for `path`, returning an unregister fn. The unregister is
 * identity-checked: if a remount already replaced the entry, the stale teardown
 * no-ops — safe regardless of React's effect/cleanup ordering.
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
  void registry.get(path)?.save();
}

/** Invoke the save registered for an exact path (used by the dirty-tab affordance). */
export function saveDocByPath(path: string): void {
  void registry.get(path)?.save();
}

/**
 * Save every dirty registered doc. Collects failures and returns them as an array
 * of failed paths. Successes are silent (the dirty-dot clearing is the signal).
 * If no registry entry exists for a dirty path it is silently skipped (e.g. a diff
 * tab that never registers a save).
 */
export async function saveAllDirtyDocs(dirtyPaths: ReadonlySet<string>): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(
    [...dirtyPaths].map(async (path) => {
      const entry = registry.get(path);
      if (!entry) return;
      const ok = await entry.save();
      if (!ok) failed.push(path);
    }),
  );
  return failed;
}

/** Revert the registered entry for a path (restore baseline, clear dirty). No-op if
 * there is no entry or the entry does not implement revert. */
export function revertDocByPath(path: string): void {
  registry.get(path)?.revert?.();
}
