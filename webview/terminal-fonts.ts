// Font lifecycle for terminals (spec 2026-11-02 §8, plan S4). xterm measures its cell and
// rasterises glyphs into the WebGL atlas from whatever face is loaded at that moment, so the
// selected faces load once before the first terminal mounts, a font change loads before the option
// is set, and a late face of the terminals' own stack re-measures and re-rasterises all of them. A failed load only logs: a
// fallback face is worse type, a blocked session is a broken app.

import type { AppSettings } from '../src/settings';
import { log } from './log';
import { type GpuCoordinator, terminalGpu } from './terminal-gpu';
import { UI_FONTS } from './themes';
import { monoStack } from './xterm-theme';

/** The glyphs Claude Code prints that fallback faces mangled, plus box drawing and an ellipsis. */
export const FONT_SAMPLE = 'Ag✔❯⚠⏺⎿●✻·…│─';
/** Past this a load carries on in fallback faces; the late face then arrives as a refresh. */
export const BOOT_FONT_TIMEOUT_MS = 3000;
const UI_SAMPLE_PX = 13;
const WEIGHTS = [400, 700] as const;

interface Face {
  family: string;
}

interface FontSet {
  load(font: string, text?: string): Promise<readonly Face[]>;
  addEventListener(
    type: 'loadingdone',
    listener: (event: { fontfaces: readonly Face[] }) => void,
  ): void;
}

export interface FontServiceDeps {
  fonts: FontSet | undefined;
  gpu: Pick<GpuCoordinator<unknown>, 'refreshFonts' | 'applyFontFamily'>;
  /** Returns the cancel. */
  setTimer(fn: () => void, ms: number): () => void;
  warn(message: string, data: Record<string, unknown>): void;
}

const unquote = (family: string) => family.trim().replace(/^["']|["']$/g, '');
const stackFamilies = (stack: string) => new Set(stack.split(',').map(unquote));

type BootSettings = Pick<AppSettings, 'fontUi' | 'fontMono' | 'terminalFontSize'>;

export function createFontService(deps: FontServiceDeps) {
  let boot: Promise<void> | null = null;
  let pending: { key: string; done: Promise<void> } | null = null;
  let latestKey: string | null = null;
  let readyKey: string | null = null;
  let activeFamily: string | null = null;
  // The stack the terminals are drawn in: only its faces arriving can change their cells.
  let activeFamilies = new Set<string>();
  // Faces that were loaded before the terminals used them; their loadingdone needs no refresh.
  const preloaded = new WeakSet<Face>();

  const requests = (stack: string, sizePx: number) =>
    WEIGHTS.map((w) => `${w} ${sizePx}px ${stack}`);

  /** Settles once every request has, or the timeout passes; never rejects. */
  const loadAll = (fonts: FontSet, specs: string[]): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      const cancel = deps.setTimer(() => {
        if (settled) return;
        settled = true;
        deps.warn('font load timed out', { fonts: specs, timeoutMs: BOOT_FONT_TIMEOUT_MS });
        resolve();
      }, BOOT_FONT_TIMEOUT_MS);
      void Promise.allSettled(specs.map((font) => fonts.load(font, FONT_SAMPLE))).then(
        (results) => {
          if (settled) return;
          settled = true;
          cancel();
          results.forEach((r, i) => {
            if (r.status === 'rejected') {
              deps.warn('font load failed', { font: specs[i], error: String(r.reason) });
            } else if (r.value.length === 0) {
              deps.warn('font load found no face', { font: specs[i] });
            } else {
              for (const face of r.value) preloaded.add(face);
            }
          });
          resolve();
        },
      );
    });

  const onLoadingDone = ({ fontfaces }: { fontfaces: readonly Face[] }) => {
    if (fontfaces.some((f) => !preloaded.has(f) && activeFamilies.has(unquote(f.family)))) {
      deps.gpu.refreshFonts();
    }
  };

  return {
    terminalFontFamily(): string | null {
      return activeFamily;
    },
    loadBootFonts(settings: BootSettings): Promise<void> {
      if (boot) return boot;
      const mono = monoStack(settings.fontMono);
      const key = `${settings.fontMono}|${settings.terminalFontSize}`;
      activeFamily = mono;
      activeFamilies = stackFamilies(mono);
      const fonts = deps.fonts;
      if (!fonts) {
        readyKey = key;
        boot = Promise.resolve();
        return boot;
      }
      fonts.addEventListener('loadingdone', onLoadingDone);
      const ui = UI_FONTS.find((f) => f.id === settings.fontUi);
      const specs = [
        ...(ui?.bundled ? requests(ui.stack, UI_SAMPLE_PX) : []),
        ...requests(mono, settings.terminalFontSize),
      ];
      boot = loadAll(fonts, specs).then(() => {
        if (latestKey === null) readyKey = key;
      });
      return boot;
    },

    applyTerminalFontChange(fontId: string, sizePx: number): Promise<void> {
      const key = `${fontId}|${sizePx}`;
      latestKey = key;
      if (readyKey === key) return Promise.resolve();
      if (pending?.key === key) return pending.done;
      const family = monoStack(fontId);
      const loaded = deps.fonts ? loadAll(deps.fonts, requests(family, sizePx)) : Promise.resolve();
      const done = loaded.then(() => {
        if (pending?.key === key) pending = null;
        if (latestKey !== key) return;
        readyKey = key;
        activeFamily = family;
        activeFamilies = stackFamilies(family);
        deps.gpu.applyFontFamily(family);
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
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  warn: (message, data) => log.warn('fonts', message, data),
});

export const loadBootFonts = service.loadBootFonts;
export const applyTerminalFontChange = service.applyTerminalFontChange;
export const terminalFontFamily = service.terminalFontFamily;
