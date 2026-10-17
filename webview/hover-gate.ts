import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Pointer hover may move the active row only once the pointer has really moved after the menu
 *  opened: a menu opens under a resting cursor, and whatever row lands there was never chosen
 *  (path-links QA r1 Q3). The first event only records where the pointer is. */
export function createHoverGate(): (x: number, y: number) => boolean {
  let origin: { x: number; y: number } | null = null;
  let moved = false;
  return (x, y) => {
    if (moved) return true;
    if (!origin) {
      origin = { x, y };
      return false;
    }
    moved = x !== origin.x || y !== origin.y;
    return moved;
  };
}

/** `resting` until the gate arms; the menu frame carries it as `data-pointer` so `:hover`
 *  paints nothing under a pointer that hasn't moved yet (styles.css, quiet ladder). */
export type PointerState = 'resting' | 'armed';

/** A `createHoverGate` per open: `resetKey` changing (a menu replaced in place) starts a fresh
 *  one. `moved` takes the pointer event's client point. */
export function useHoverGate(resetKey?: unknown): {
  pointer: PointerState;
  moved: (e: { clientX: number; clientY: number }) => boolean;
} {
  const gate = useRef(createHoverGate());
  const [pointer, setPointer] = useState<PointerState>('resting');

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey identity is the trigger.
  useLayoutEffect(() => {
    gate.current = createHoverGate();
    setPointer('resting');
  }, [resetKey]);

  const moved = useCallback((e: { clientX: number; clientY: number }) => {
    const armed = gate.current(e.clientX, e.clientY);
    if (armed) setPointer('armed');
    return armed;
  }, []);

  return { pointer, moved };
}
