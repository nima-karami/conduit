import { type RefObject, useLayoutEffect } from 'react';

// Pinned footers need vertical clearance where the stack normally sits (CON-71).
// Floating side panels occupy that entire column, so the stack uses the space beside them.
type Edge = 'floor' | 'side';
const reservations = new Map<symbol, { edge: Edge; distance: number }>();

function clearance(edge: Edge): number {
  let distance = 0;
  for (const reservation of reservations.values()) {
    if (reservation.edge === edge) distance = Math.max(distance, reservation.distance);
  }
  return distance;
}

export function toastFloorPx(): number {
  return clearance('side') > 0 ? 0 : clearance('floor');
}

function apply() {
  const root = document.documentElement;
  const positions = { '--toast-floor': toastFloorPx(), '--toast-side': clearance('side') };
  for (const [property, distance] of Object.entries(positions)) {
    if (distance > 0) root.style.setProperty(property, `${Math.ceil(distance)}px`);
    else root.style.removeProperty(property);
  }
}

function useToastClearance(ref: RefObject<HTMLElement | null>, edge: Edge, active: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const key = Symbol(edge);
    const measure = () => {
      const { left, top } = el.getBoundingClientRect();
      const distance = edge === 'side' ? window.innerWidth - left : window.innerHeight - top;
      reservations.set(key, { edge, distance });
      apply();
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      reservations.delete(key);
      apply();
    };
  }, [ref, edge, active]);
}

export function useToastFloor(ref: RefObject<HTMLElement | null>, active: boolean) {
  useToastClearance(ref, 'floor', active);
}

export function useToastSide(ref: RefObject<HTMLElement | null>) {
  useToastClearance(ref, 'side', true);
}
