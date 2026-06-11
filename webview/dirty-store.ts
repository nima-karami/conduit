import { nextDirtySet } from './dirty-state';

/**
 * Shared dirty-state store (I2). The CodeViewer (which owns the Monaco model and
 * the on-disk baseline) updates a path's dirty flag here; the tab bar subscribes to
 * render the unsaved-changes dot. A tiny external store rather than React context so
 * the editor's per-keystroke updates don't have to thread props up through the tree.
 *
 * Keyed by file PATH (the doc tab id is `file:${path}`), matching how files are
 * keyed everywhere else in the renderer.
 */

type Listener = () => void;

let dirty: ReadonlySet<string> = new Set();
const listeners = new Set<Listener>();

function notify(next: ReadonlySet<string>) {
  if (next === dirty) return; // membership unchanged — skip the re-render
  dirty = next;
  listeners.forEach((l) => {
    l();
  });
}

/** Recompute `path`'s dirty flag from its on-disk baseline vs the live buffer. */
export function updateDirty(path: string, baseline: string, buffer: string): void {
  notify(nextDirtySet(dirty, path, baseline, buffer));
}

/** Drop a path entirely (e.g. when its tab closes). */
export function clearDirty(path: string): void {
  if (!dirty.has(path)) return;
  const next = new Set(dirty);
  next.delete(path);
  notify(next);
}

/** Snapshot of the dirty set (stable reference until membership changes). */
export function getDirtySnapshot(): ReadonlySet<string> {
  return dirty;
}

export function subscribeDirty(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
