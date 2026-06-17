import { useCallback, useEffect, useRef } from 'react';

/**
 * Pure factory for a debounced-with-flush controller, backing useDebouncedFlush.
 * flush() fires the callback immediately if pending; cancel() clears without firing.
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
 * React hook: debounced save that flushes any pending save on unmount so a
 * quick-close never drops data. The callback ref ensures the controller always
 * calls the LATEST cb without being recreated.
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
