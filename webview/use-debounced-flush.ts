import { useCallback, useEffect, useRef } from 'react';

/**
 * Pure factory for a debounced-with-flush controller.
 * Used in tests and as the implementation backing useDebouncedFlush.
 *
 * Returns { schedule, flush, cancel }:
 *   schedule()  — starts/restarts the timer (the debounce).
 *   flush()     — fires the callback immediately if pending, clears the timer.
 *   cancel()    — clears the timer without firing.
 */
export function makeDebouncedFlush(
  cb: () => void,
  delayMs: number,
): { schedule: () => void; flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      timer = null;
      cb();
    }, delayMs);
  };

  const flush = () => {
    if (!pending) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
    cb();
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  };

  return { schedule, flush, cancel };
}

/**
 * React hook: debounced save with flush on unmount.
 *
 * Usage:
 *   const { schedule } = useDebouncedFlush(() => post({ type: 'updateBoard', ... }), 300);
 *   // call schedule() whenever data changes.
 *   // On unmount the hook automatically flushes any pending save.
 *
 * The callback ref pattern ensures the closure always calls the LATEST cb
 * without requiring the hook to be recreated.
 */
export function useDebouncedFlush(
  cb: () => void,
  delayMs: number,
): { schedule: () => void; cancel: () => void } {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  const controllerRef = useRef<ReturnType<typeof makeDebouncedFlush> | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = makeDebouncedFlush(() => cbRef.current(), delayMs);
  }

  // Flush any pending save on unmount so quick-close never drops data.
  useEffect(() => {
    return () => {
      controllerRef.current?.flush();
    };
  }, []);

  const schedule = useCallback(() => {
    controllerRef.current?.schedule();
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.cancel();
  }, []);

  return { schedule, cancel };
}
