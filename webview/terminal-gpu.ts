// One coordinator per document for every terminal's WebGL renderer. @xterm/addon-webgl shares a
// module-level texture atlas between all terminals with the same config, and a GPU-process restart
// wipes its pixels while the glyph map still believes every glyph is drawn — so each pane paints
// only its cursor. The contexts come back inside xterm's own 3 s window, so `onContextLoss` never
// fires. The cache entry is only dropped once its LAST owner disposes, so recovering one terminal
// alone reacquires the blank atlas: every addon has to go, then all come back fresh.

import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import { safeDispose } from './components/safe-dispose';
import { log } from './log';

export const GPU_REATTACH_DELAY_MS = 1000;
export const GPU_LOSS_WINDOW_MS = 60_000;
export const GPU_GIVE_UP_LOSSES = 3;

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

  const reattach = () => {
    mode = 'webgl';
    let attached = 0;
    for (const term of entries.keys()) {
      const handle = deps.attach(term);
      entries.set(term, handle);
      if (handle) attached++;
    }
    deps.log('reattach', { terminals: entries.size, attached });
  };

  return {
    register(term) {
      entries.set(term, mode === 'webgl' ? deps.attach(term) : null);
      return () => {
        if (!entries.has(term)) return;
        entries.get(term)?.dispose();
        entries.delete(term);
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
      // Fires only when a context stays lost past xterm's 3 s window (e.g. evicted by the
      // per-page context cap); a GPU restart reaches reportLoss through `webglcontextlost`.
      addon.onContextLoss(() => terminalGpu.reportLoss(term));
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
