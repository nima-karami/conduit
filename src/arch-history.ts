// Document-level undo/redo stack (spec 2026-07-06-arch-foundation-ports-types §Undo/redo).
// Generic over the document type — the architecture view holds `History<ArchDoc>`. Every mutation
// pushes a new present; a `tag` coalesces a continuous gesture (a node drag, an inline rename) into
// a single undo step. Pure + immutable; the view owns the state.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Tag of the most recent push, for coalescing; reset by undo/redo. */
  tag?: string;
}

/** Max retained undo steps; oldest drop off (spec F default). */
const MAX_DEPTH = 100;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * Record a new present. When `tag` matches the previous push's tag, the two **coalesce**: the
 * present is replaced without growing the past (so one gesture = one undo step). Any push clears
 * the redo future.
 */
export function push<T>(h: History<T>, present: T, tag?: string): History<T> {
  if (tag !== undefined && tag === h.tag) {
    return { past: h.past, present, future: [], tag };
  }
  const past = [...h.past, h.present];
  if (past.length > MAX_DEPTH) past.splice(0, past.length - MAX_DEPTH);
  return { past, present, future: [], tag };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const present = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present,
    future: [h.present, ...h.future],
    tag: undefined,
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [present, ...future] = h.future;
  return { past: [...h.past, h.present], present, future, tag: undefined };
}
