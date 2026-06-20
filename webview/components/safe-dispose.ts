// Disposing xterm and its addons can throw — most notably the WebGL addon, whose
// teardown reads `_isDisposed`, `undefined` when its GL context never initialized
// (GPU-less / blocklisted / headless, or a lost context). An unguarded throw here
// propagates out of React cleanup and blanks the whole root to black.

import { log } from '../log';

export interface Disposable {
  dispose?: () => void;
}

/**
 * Dispose a single xterm-style disposable, swallowing (and warning on) any error.
 * Returns true if `dispose()` ran without throwing.
 */
export function safeDispose(d: Disposable | null | undefined, label = 'disposable'): boolean {
  if (!d || typeof d.dispose !== 'function') return false;
  try {
    d.dispose();
    return true;
  } catch (e) {
    log.warn('renderer', `${label} dispose threw (ignored)`, {
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Dispose addons then the terminal, each guarded. Order matters: addons (WebGL, fit)
 * must be torn down before the Terminal that owns them, and the throwy WebGL addon is
 * isolated so its throw can't skip the terminal's own dispose.
 */
export function disposeTerminal(
  term: Disposable | null | undefined,
  addons: (Disposable | null | undefined)[],
): void {
  for (const a of addons) safeDispose(a, 'xterm addon');
  safeDispose(term, 'xterm terminal');
}
