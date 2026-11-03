/**
 * Long enough that a folder whose watch overflows every second costs two rechecks a minute
 * instead of sixty; short enough that a change the overflow hid is still picked up by the
 * trailing recheck well before a user would go looking for it.
 */
export const SUSPECT_WINDOW_MS = 30_000;

export interface SuspectBackoff<T> {
  /** `value` is what the recheck is for; a repeat replaces it, so the trailing one gets the latest. */
  hit(key: string, value: T): void;
  dispose(): void;
}

/**
 * Per-folder coalescing of "the watch can't be trusted" signals. The first one rechecks at once;
 * repeats inside the window become one trailing recheck (with their count) when it ends, which
 * opens the next window — so a steady stream rechecks once per window, and a window without
 * repeats ends quietly.
 */
export function createSuspectBackoff<T>(opts: {
  windowMs: number;
  onRecheck: (value: T, repeats: number) => void;
}): SuspectBackoff<T> {
  const windows = new Map<
    string,
    { value: T; repeats: number; timer: ReturnType<typeof setTimeout> }
  >();
  const open = (key: string, value: T) => {
    windows.set(key, { value, repeats: 0, timer: setTimeout(() => close(key), opts.windowMs) });
  };
  const close = (key: string) => {
    const w = windows.get(key);
    windows.delete(key);
    if (!w?.repeats) return;
    open(key, w.value);
    opts.onRecheck(w.value, w.repeats);
  };
  return {
    hit(key, value) {
      const w = windows.get(key);
      if (w) {
        w.repeats++;
        w.value = value;
        return;
      }
      open(key, value);
      opts.onRecheck(value, 1);
    },
    dispose() {
      for (const w of windows.values()) clearTimeout(w.timer);
      windows.clear();
    },
  };
}
