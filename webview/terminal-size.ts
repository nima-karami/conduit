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
 * held. See CLAUDE.md: PTY size must equal the xterm's size.
 */
export function createPtySizeSync(opts: {
  term: TermGeometry;
  faceLoaded: () => boolean;
  report: (size: TermGeometry, reason: PtySizeReason) => void;
}): { afterFit(): void; afterFontRefresh(): void } {
  let started = false;
  let sent: TermGeometry | null = null;
  const current = (): TermGeometry => ({ cols: opts.term.cols, rows: opts.term.rows });

  const emit = (allowFallback: boolean) => {
    const size = current();
    if (size.cols <= 0 || size.rows <= 0) return;
    if (!started) {
      if (!allowFallback && !opts.faceLoaded()) return;
      started = true;
      sent = size;
      opts.report(size, 'start');
      return;
    }
    if (!sizeDiffers(sent, size)) return;
    sent = size;
    opts.report(size, 'resize');
  };

  return {
    afterFit: () => emit(false),
    afterFontRefresh: () => emit(true),
  };
}
