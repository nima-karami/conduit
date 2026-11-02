// One coordinator per document for every terminal's WebGL renderer. @xterm/addon-webgl shares a
// module-level texture atlas between all terminals with the same config, and a GPU-process restart
// wipes its pixels while the glyph map still believes every glyph is drawn — so each pane paints
// only its cursor. The contexts come back inside xterm's own 3 s window, so `onContextLoss` never
// fires. The cache entry is only dropped once its LAST owner disposes, so recovering one terminal
// alone reacquires the blank atlas: every addon has to go, then all come back fresh.
// Losses arrive through terminal-pane's capture-phase `webglcontextlost` listener, which disposes
// the addon before xterm's own timer can fire, so the addon's `onContextLoss` is not subscribed.

import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import { safeDispose } from './components/safe-dispose';
import { GPU_LOSS_WINDOW_MS, noteGpuLoss } from './gpu-loss-policy';
import { log } from './log';

export const GPU_REATTACH_DELAY_MS = 1000;
// Under Chromium's ~16 live contexts per page, leaving room for the shader background: past the
// limit Chromium evicts the oldest context, which would read here as a GPU reset.
export const MAX_WEBGL_TERMINALS = 12;
// Chromium refuses new WebGL contexts for the page for a while after a repeat GPU reset (we keep
// that guard; see electron/main.ts). Terminals it refuses stay on DOM and retry on this schedule,
// which starts over once every terminal is back on WebGL.
// A refused attach is not a loss, so it never counts toward the loss cap.
export const GPU_UNAVAILABLE_RETRY_MS: readonly number[] = [30_000, 120_000, 300_000];

export interface WebglHandle {
  dispose(): void;
}

export interface GpuCoordinatorDeps<T> {
  now(): number;
  setTimer(fn: () => void, ms: number): void;
  /** Load a fresh WebGL renderer onto `term`; null leaves it on the DOM renderer. */
  attach(term: T): WebglHandle | null;
  log(
    event: 'context-lost' | 'reattach' | 'unavailable' | 'give-up',
    data: Record<string, unknown>,
  ): void;
  /** Re-measure the cell in the faces now loaded (see remeasureFont). */
  remeasureFont(term: T): void;
  /** Drop every rasterised glyph, so the next paint re-draws in the faces now loaded. */
  clearFontAtlas(term: T): void;
  refreshTerminal(term: T): void;
  /** Changed-only: an identical family assignment is a no-op in xterm, never an atlas clear. */
  applyFontFamily(term: T, family: string): void;
}

export interface GpuCoordinator<T> {
  /**
   * Returns the unregister, which disposes the terminal's WebGL addon if it has one.
   * `onFontRefresh` re-fits the pane and re-reports its facts after a font refresh.
   */
  register(term: T, onFontRefresh?: () => void): () => void;
  reportLoss(term: T): void;
  /** A face finished loading: every live terminal re-rasterises (spec 2026-11-02 §8). */
  refreshFonts(): void;
  applyFontFamily(family: string): void;
}

export function createGpuCoordinator<T>(deps: GpuCoordinatorDeps<T>): GpuCoordinator<T> {
  const entries = new Map<T, WebglHandle | null>();
  const fontRefresh = new Map<T, () => void>();
  let mode: 'webgl' | 'fallback' | 'dom' = 'webgl';
  let losses: number[] = [];
  let live = 0;
  // Terminals whose attach failed wait for the next re-attach rather than retrying on every promotion.
  const failed = new Set<T>();
  let retriesUsed = 0;
  // Bumped by every loss, so a retry scheduled before it does nothing.
  let generation = 0;

  const attach = (term: T): boolean => {
    const handle = deps.attach(term);
    entries.set(term, handle);
    if (handle) live++;
    else failed.add(term);
    return !!handle;
  };

  const fill = () => {
    if (entries.size === 0) return;
    failed.clear();
    for (const [term, handle] of entries) {
      if (live >= MAX_WEBGL_TERMINALS) break;
      if (!handle) attach(term);
    }
    if (live >= Math.min(entries.size, MAX_WEBGL_TERMINALS)) {
      retriesUsed = 0;
      deps.log('reattach', { terminals: entries.size, attached: live });
      return;
    }
    const retryMs = GPU_UNAVAILABLE_RETRY_MS[retriesUsed];
    deps.log('unavailable', { terminals: entries.size, attached: live, retryMs: retryMs ?? null });
    if (retryMs === undefined) return;
    retriesUsed++;
    const scheduled = generation;
    deps.setTimer(() => {
      if (mode === 'webgl' && generation === scheduled) fill();
    }, retryMs);
  };

  const reattach = () => {
    mode = 'webgl';
    fill();
  };

  const refreshAll = () => {
    for (const term of entries.keys()) deps.refreshTerminal(term);
    for (const term of entries.keys()) fontRefresh.get(term)?.();
  };

  const promoteOldestWaiting = () => {
    for (const [term, handle] of entries) {
      if (!handle && !failed.has(term) && attach(term)) return;
    }
  };

  return {
    register(term, onFontRefresh) {
      entries.set(term, null);
      if (onFontRefresh) fontRefresh.set(term, onFontRefresh);
      if (mode === 'webgl' && live < MAX_WEBGL_TERMINALS) attach(term);
      return () => {
        fontRefresh.delete(term);
        if (!entries.has(term)) return;
        const handle = entries.get(term);
        entries.delete(term);
        failed.delete(term);
        if (!handle) return;
        handle.dispose();
        live--;
        // Only a WebGL terminal frees a slot, and none exist outside webgl mode.
        promoteOldestWaiting();
      };
    },
    reportLoss(term) {
      // Every context in the document is lost together, so the rest of the burst lands here.
      if (mode !== 'webgl' || !entries.has(term)) return;
      generation++;
      const noted = noteGpuLoss(losses, deps.now());
      losses = noted.losses;
      for (const [t, handle] of entries) {
        handle?.dispose();
        entries.set(t, null);
      }
      live = 0;
      if (noted.exhausted) {
        mode = 'dom';
        deps.log('give-up', { losses: losses.length, windowMs: GPU_LOSS_WINDOW_MS });
        return;
      }
      mode = 'fallback';
      deps.log('context-lost', { terminals: entries.size, lossesInWindow: losses.length });
      deps.setTimer(reattach, GPU_REATTACH_DELAY_MS);
    },
    refreshFonts() {
      // Glyphs cached in a fallback face stay in every atlas holding them, and the WebGL atlas is
      // shared between terminals, so all are cleared before any repaints.
      for (const term of entries.keys()) {
        deps.remeasureFont(term);
        deps.clearFontAtlas(term);
      }
      refreshAll();
    },
    applyFontFamily(family) {
      for (const term of entries.keys()) deps.applyFontFamily(term, family);
      refreshAll();
    },
  };
}

/**
 * xterm measures its cell only when a font option's value changes, so a face that lands after the
 * terminal was built leaves the fallback face's cell size; an identical assignment is a no-op.
 */
export function remeasureFont(term: { options: { fontFamily?: string } }): void {
  const family = term.options.fontFamily ?? 'monospace';
  term.options.fontFamily = family === 'monospace' ? 'serif' : 'monospace';
  term.options.fontFamily = family;
}

export const terminalGpu: GpuCoordinator<Terminal> = createGpuCoordinator<Terminal>({
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    setTimeout(fn, ms);
  },
  attach: (term) => {
    let addon: WebglAddon | null = null;
    try {
      addon = new WebglAddon();
      term.loadAddon(addon);
      const loaded = addon;
      return { dispose: () => safeDispose(loaded, 'xterm webgl addon') };
    } catch {
      safeDispose(addon, 'xterm webgl addon');
      return null;
    }
  },
  log: (event, data) => log.warn('terminal', `webgl ${event}`, data),
  remeasureFont,
  clearFontAtlas: (term) => term.clearTextureAtlas(),
  refreshTerminal: (term) => term.refresh(0, term.rows - 1),
  applyFontFamily: (term, family) => {
    if (term.options.fontFamily !== family) term.options.fontFamily = family;
  },
});
