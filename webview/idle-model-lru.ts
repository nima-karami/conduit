/**
 * Closed tabs keep their Monaco model for cross-file resolution; this bounds how many idle ones
 * stay. Oldest-idle goes first; a model shown again leaves the queue.
 */
export function createIdleLru<K>(cap: number, evict: (key: K) => void) {
  const idle = new Set<K>();
  return {
    markIdle(key: K) {
      idle.delete(key);
      idle.add(key);
      for (const k of idle) {
        if (idle.size <= cap) break;
        idle.delete(k);
        evict(k);
      }
    },
    markActive(key: K) {
      idle.delete(key);
    },
    size: () => idle.size,
  };
}

export interface IdleModelDeps {
  cap: number;
  /** Asked when a path goes idle and again when its turn comes: false spares it (unsaved edits,
   *  a save entry still bound to the model, no extraLib to fall back on). */
  canDispose(path: string): boolean;
  dispose(path: string): void;
}

/**
 * A model goes idle when the last open file tab for its path closes — never when its viewer
 * unmounts: center-pane mounts only each group's shown doc, so every tab switch unmounts the
 * viewer of a tab that is still open, and that model is the tab's buffer and undo history.
 */
export function createIdleModels(deps: IdleModelDeps) {
  let open: ReadonlySet<string> = new Set();
  const lru = createIdleLru<string>(deps.cap, (path) => {
    if (!open.has(path) && deps.canDispose(path)) deps.dispose(path);
  });
  return {
    /** `next`: every path an open `file` doc in this window shows. */
    syncOpenPaths(next: ReadonlySet<string>): void {
      const prev = open;
      open = next;
      for (const path of next) if (!prev.has(path)) lru.markActive(path);
      for (const path of prev) if (!next.has(path) && deps.canDispose(path)) lru.markIdle(path);
    },
    size: lru.size,
  };
}
