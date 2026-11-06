import type { TermGeometry } from '../src/protocol';
import { sizeDiffers } from './terminal-conpty';

export interface FontFaceLike {
  family: string;
  status: string;
}

export interface FontSetLike {
  check?(font: string): boolean;
  [Symbol.iterator]?(): Iterator<FontFaceLike>;
}

/** Primary family of a CSS stack (`"IBM Plex Mono", ui-monospace` → IBM Plex Mono). */
function primaryFamily(stack: string): string {
  const first = stack.split(',')[0] ?? stack;
  return first.trim().replace(/^["']|["']$/g, '');
}

/**
 * Whether the terminal's selected face is in and measured. `check` true is a system font
 * (nothing to wait for). A named family that is not yet registered, or is still loading, is a
 * fallback-cell fit that must not be sent to hc. Once every matching face has settled (loaded
 * or error), waiting is over even if `check` is quirky.
 */
export function terminalFaceLoaded(
  family: string | null,
  sizePx: number,
  fonts: FontSetLike | undefined,
): boolean {
  if (!family || !fonts) return true;
  const primary = primaryFamily(family);
  try {
    if (fonts.check?.(`${sizePx}px "${primary}"`) === true) return true;
  } catch {
    return true;
  }
  const faces: FontFaceLike[] = [];
  if (typeof fonts[Symbol.iterator] === 'function') {
    for (const face of fonts as Iterable<FontFaceLike>) {
      if (face.family.includes(primary)) faces.push(face);
    }
  }
  if (faces.length === 0) return false;
  return !faces.some((f) => f.status === 'loading' || f.status === 'unloaded');
}

export type PtySizeReason = 'start' | 'resize';

/**
 * Gate that reports a pane's size to hc only after the xterm actually has it. A FitAddon
 * proposeDimensions that was never applied, or a fallback-face fit the xterm will not keep, is
 * held. The hold always releases: selected face loaded, that load failing, `document.fonts.ready`
 * with the face still unavailable, or a non-GPU path that never calls refreshFonts. See CLAUDE.md:
 * PTY size must equal the xterm's size.
 */
export function createPtySizeSync(opts: {
  term: TermGeometry;
  faceLoaded: () => boolean;
  report: (size: TermGeometry, reason: PtySizeReason) => void;
  /** `document.fonts.ready` — if the face is still missing, the current (fallback) size is kept. */
  fontsReady?: Promise<unknown>;
  /** Rejects when the selected face's load fails. */
  faceLoad?: Promise<unknown>;
  /** False when fonts are handled without refreshFonts (no GPU atlas remasure). */
  gpu?: boolean | (() => boolean);
}): { afterFit(): void; afterFontRefresh(): void; dispose(): void } {
  let started = false;
  let sent: TermGeometry | null = null;
  let fitted = false;
  let alive = true;
  let fallbackOk = opts.gpu === false;
  const current = (): TermGeometry => ({ cols: opts.term.cols, rows: opts.term.rows });
  const gpuPath = (): boolean => {
    const g = opts.gpu;
    if (typeof g === 'function') return g();
    return g !== false;
  };

  const emit = () => {
    if (!alive || !fitted) return;
    const size = current();
    if (size.cols <= 0 || size.rows <= 0) return;
    if (!started) {
      if (!fallbackOk && !opts.faceLoaded()) return;
      started = true;
      sent = size;
      opts.report(size, 'start');
      return;
    }
    if (!sizeDiffers(sent, size)) return;
    sent = size;
    opts.report(size, 'resize');
  };

  const releaseFallback = () => {
    fallbackOk = true;
    emit();
  };

  void opts.fontsReady?.then(releaseFallback, releaseFallback);
  void opts.faceLoad?.then(undefined, releaseFallback);

  return {
    afterFit: () => {
      fitted = true;
      if (!gpuPath()) fallbackOk = true;
      emit();
    },
    afterFontRefresh: () => {
      fitted = true;
      fallbackOk = true;
      emit();
    },
    dispose: () => {
      alive = false;
    },
  };
}
