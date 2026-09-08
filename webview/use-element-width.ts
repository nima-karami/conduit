import { type RefObject, useEffect, useState } from 'react';

/**
 * Live inline width of `ref`'s element via `ResizeObserver`. Returns `+Infinity` until the
 * first observation lands, so nothing is treated as compact before a real measurement
 * (avoids a one-frame flash of the narrow layout on mount).
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
