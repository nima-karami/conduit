// Font lifecycle for terminals (spec 2026-11-02 §8, plan S4). xterm measures its cell and
// rasterises glyphs into the WebGL atlas from whatever face is loaded at that moment, so the
// selected faces load once before the first terminal mounts, a font change loads before the option
// is set, and any later face arrival clears every terminal's atlas. A failed load only logs: a
// fallback face is worse type, a blocked session is a broken app.

import type { AppSettings } from '../src/settings';
import { log } from './log';
import { type GpuCoordinator, terminalGpu } from './terminal-gpu';
import { UI_FONTS } from './themes';
import { monoStack } from './xterm-theme';

/** The glyphs Claude Code prints that fallback faces mangled, plus box drawing and an ellipsis. */
export const FONT_SAMPLE = 'Ag✔❯⚠⏺⎿●✻·…│─';
/** Past this the boot carries on in fallback faces; the late face then arrives as a refresh. */
export const BOOT_FONT_TIMEOUT_MS = 3000;
const UI_SAMPLE_PX = 13;
const WEIGHTS = [400, 700] as const;

interface FontSet {
  load(font: string, text?: string): Promise<unknown[]>;
  addEventListener(type: 'loadingdone', listener: () => void): void;
}

export interface FontServiceDeps {
  fonts: FontSet | undefined;
  gpu: Pick<GpuCoordinator<unknown>, 'refreshFonts' | 'applyFontFamily'>;
  setTimer(fn: () => void, ms: number): void;
  warn(message: string, data: Record<string, unknown>): void;
}

type BootSettings = Pick<AppSettings, 'fontUi' | 'fontMono' | 'terminalFontSize'>;

export function createFontService(deps: FontServiceDeps) {
  let boot: Promise<void> | null = null;
  let pending: { key: string; done: Promise<void> } | null = null;
  let latestKey: string | null = null;

  const requests = (stack: string, sizePx: number) =>
    WEIGHTS.map((w) => `${w} ${sizePx}px ${stack}`);

  /** Settles once every request has, or the timeout passes; never rejects. */
  const loadAll = (fonts: FontSet, specs: string[], timeoutMs?: number): Promise<void> => {
    const all = Promise.allSettled(specs.map((font) => fonts.load(font, FONT_SAMPLE))).then(
      (results) => {
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            deps.warn('font load failed', { font: specs[i], error: String(r.reason) });
          } else if (r.value.length === 0) {
            deps.warn('font load found no face', { font: specs[i] });
          }
        });
      },
    );
    if (timeoutMs === undefined) return all;
    return Promise.race([
      all,
      new Promise<void>((resolve) =>
        deps.setTimer(() => {
          deps.warn('font load timed out', { fonts: specs, timeoutMs });
          resolve();
        }, timeoutMs),
      ),
    ]);
  };

  return {
    loadBootFonts(settings: BootSettings): Promise<void> {
      if (boot) return boot;
      const fonts = deps.fonts;
      if (!fonts) {
        boot = Promise.resolve();
        return boot;
      }
      fonts.addEventListener('loadingdone', () => deps.gpu.refreshFonts());
      const ui = UI_FONTS.find((f) => f.id === settings.fontUi);
      const specs = [
        ...(ui?.bundled ? requests(ui.stack, UI_SAMPLE_PX) : []),
        ...requests(monoStack(settings.fontMono), settings.terminalFontSize),
      ];
      boot = loadAll(fonts, specs, BOOT_FONT_TIMEOUT_MS);
      return boot;
    },

    applyTerminalFontChange(fontId: string, sizePx: number): Promise<void> {
      const key = `${fontId}|${sizePx}`;
      latestKey = key;
      if (pending?.key === key) return pending.done;
      const family = monoStack(fontId);
      const loaded = deps.fonts ? loadAll(deps.fonts, requests(family, sizePx)) : Promise.resolve();
      const done = loaded.then(() => {
        if (pending?.key === key) pending = null;
        if (latestKey === key) deps.gpu.applyFontFamily(family);
      });
      pending = { key, done };
      return done;
    },
  };
}

const service = createFontService({
  fonts: typeof document === 'undefined' ? undefined : document.fonts,
  gpu: terminalGpu,
  setTimer: (fn, ms) => {
    setTimeout(fn, ms);
  },
  warn: (message, data) => log.warn('fonts', message, data),
});

export const loadBootFonts = service.loadBootFonts;
export const applyTerminalFontChange = service.applyTerminalFontChange;
