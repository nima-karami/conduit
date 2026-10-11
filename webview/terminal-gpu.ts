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
import { log } from './log';

export const GPU_REATTACH_DELAY_MS = 1000;
export const GPU_LOSS_WINDOW_MS = 60_000;
export const GPU_GIVE_UP_LOSSES = 3;
// Under Chromium's ~16 live contexts per page, leaving room for the shader background: past the
// limit Chromium evicts the oldest context, which would read here as a GPU reset.
export const MAX_WEBGL_TERMINALS = 12;

export interface WebglHandle {
  dispose(): void;
}

export interface GpuCoordinatorDeps<T> {
  now(): number;
  setTimer(fn: () => void, ms: number): void;
  /** Load a fresh WebGL renderer onto `term`; null leaves it on the DOM renderer. */
  attach(term: T): WebglHandle | null;
  log(event: 'context-lost' | 'reattach' | 'give-up', data: Record<string, unknown>): void;
}

export interface GpuCoordinator<T> {
  /** Returns the unregister, which disposes the terminal's WebGL addon if it has one. */
  register(term: T): () => void;
  reportLoss(term: T): void;
}

export function createGpuCoordinator<T>(deps: GpuCoordinatorDeps<T>): GpuCoordinator<T> {
  const entries = new Map<T, WebglHandle | null>();
  let mode: 'webgl' | 'fallback' | 'dom' = 'webgl';
  let losses: number[] = [];
  let live = 0;
  // Terminals whose attach failed wait for the next re-attach rather than retrying on every promotion.
  const failed = new Set<T>();

  const attach = (term: T): boolean => {
    const handle = deps.attach(term);
    entries.set(term, handle);
    if (handle) live++;
    else failed.add(term);
    return !!handle;
  };

  const reattach = () => {
    mode = 'webgl';
    failed.clear();
    for (const term of entries.keys()) {
      if (live >= MAX_WEBGL_TERMINALS) break;
      attach(term);
    }
    deps.log('reattach', { terminals: entries.size, attached: live });
  };

  const promoteOldestWaiting = () => {
    for (const [term, handle] of entries) {
      if (!handle && !failed.has(term) && attach(term)) return;
    }
  };

  return {
    register(term) {
      entries.set(term, null);
      if (mode === 'webgl' && live < MAX_WEBGL_TERMINALS) attach(term);
      return () => {
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
      const now = deps.now();
      losses = [...losses.filter((t) => now - t < GPU_LOSS_WINDOW_MS), now];
      for (const [t, handle] of entries) {
        handle?.dispose();
        entries.set(t, null);
      }
      live = 0;
      if (losses.length > GPU_GIVE_UP_LOSSES) {
        mode = 'dom';
        deps.log('give-up', { losses: losses.length, windowMs: GPU_LOSS_WINDOW_MS });
        return;
      }
      mode = 'fallback';
      deps.log('context-lost', { terminals: entries.size, lossesInWindow: losses.length });
      deps.setTimer(reattach, GPU_REATTACH_DELAY_MS);
    },
  };
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
});
