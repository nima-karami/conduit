import { type RefObject, useLayoutEffect } from 'react';

// The floating stack (.toasts) is anchored to the window's bottom-right, where a drawer pins its
// actions. Elements registered here raise the stack's floor above them instead of being covered
// (CON-71; CON-57 goal.md decision 6). The floor is measured, so it follows density and layout.
const floors = new Map<symbol, number>();

function apply() {
  const root = document.documentElement;
  const floor = Math.max(0, ...floors.values());
  if (floor > 0) root.style.setProperty('--toast-floor', `${Math.ceil(floor)}px`);
  else root.style.removeProperty('--toast-floor');
}

/** Exported for tests; components use `useToastFloor`. */
export function toastFloorPx(): number {
  return Math.max(0, ...floors.values());
}

export function useToastFloor(ref: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const key = Symbol('toast-floor');
    const measure = () => {
      floors.set(key, window.innerHeight - el.getBoundingClientRect().top);
      apply();
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      floors.delete(key);
      apply();
    };
  }, [ref, active]);
}
