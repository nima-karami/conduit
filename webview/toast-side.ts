import { type RefObject, useLayoutEffect } from 'react';

// The stack sits beside open drawers so every control in their scrollable bodies remains reachable.
const drawerClearances = new Map<symbol, number>();

function apply() {
  const { style } = document.documentElement;
  const side = Math.max(0, ...drawerClearances.values());
  if (side > 0) style.setProperty('--toast-side', `${Math.ceil(side)}px`);
  else style.removeProperty('--toast-side');
}

export function useToastSide(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const drawer = ref.current;
    if (!drawer) return;
    const key = Symbol();
    const measure = () => {
      drawerClearances.set(key, window.innerWidth - drawer.getBoundingClientRect().left);
      apply();
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(drawer);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      drawerClearances.delete(key);
      apply();
    };
  }, [ref]);
}
