// Disposing xterm and its addons on teardown can throw — most notably the WebGL
// addon, whose teardown reads internal state (`_isDisposed`) that is `undefined`
// when its GL context never fully initialized (GPU-less / blocklisted / headless
// machines, or a context that was lost). An unguarded throw here propagates out
// of React's cleanup and, with no error boundary, blanks the whole root to black.
//
// `safeDispose` swallows any teardown error (logging a warning) so unmounting a
// terminal can NEVER throw. It accepts anything with an optional `dispose`
// method, so it works for the Terminal and every addon (WebGL / fit / …) and is
// a no-op for null/undefined.

export interface Disposable {
  dispose?: () => void;
}

/**
 * Dispose a single xterm-style disposable, swallowing (and warning on) any error.
 * Returns true if `dispose()` ran without throwing, false if it threw or there
 * was nothing to dispose.
 */
export function safeDispose(d: Disposable | null | undefined, label = 'disposable'): boolean {
  if (!d || typeof d.dispose !== 'function') return false;
  try {
    d.dispose();
    return true;
  } catch (e) {
    // Don't rethrow: a teardown failure must not break unmounting / black-screen.
    console.warn(
      `[conduit] ${label} dispose threw (ignored):`,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/**
 * Dispose addons then the terminal, each guarded. Order matters: addons (WebGL,
 * fit) must be torn down before the Terminal that owns them — the WebGL addon's
 * own dispose is the throwy one, so it goes first and is isolated so a throw
 * there can't skip the terminal's own dispose.
 */
export function disposeTerminal(
  term: Disposable | null | undefined,
  addons: (Disposable | null | undefined)[],
): void {
  for (const a of addons) safeDispose(a, 'xterm addon');
  safeDispose(term, 'xterm terminal');
}
