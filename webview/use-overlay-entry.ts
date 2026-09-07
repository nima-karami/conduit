import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { modalDepth } from '../src/overlay-stack';
import {
  getOverlays,
  nextOverlayId,
  type OverlayKind,
  registerOverlay,
  subscribeOverlays,
  unregisterOverlay,
} from './overlay-store';

/**
 * Registers the calling component on the app's single overlay stack for its lifetime. `depth`
 * is this entry's index among modal entries only (-1 if absent/not yet registered, e.g. the
 * first paint before the mount effect runs) — callers needing a non-negative z clamp it.
 */
export function useOverlayEntry(kind: OverlayKind, onDismiss?: () => void): { depth: number } {
  const [id] = useState(nextOverlayId);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useLayoutEffect(() => {
    registerOverlay(id, kind, () => onDismissRef.current?.());
    return () => unregisterOverlay(id);
  }, [id, kind]);

  const stack = useSyncExternalStore(subscribeOverlays, getOverlays);
  return { depth: modalDepth(stack, id) };
}
