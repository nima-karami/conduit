// The xterm setup every Conduit terminal shares, so a remote pane and a local pane cannot drift
// apart on font, theme, ConPTY or WebGL handling. A caller adds only what is its own.

import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import type { WindowsPtyInfo } from '../src/protocol';
import { windowsPtyOptions } from './terminal-conpty';
import { terminalFontFamily } from './terminal-fonts';
import { terminalGpu } from './terminal-gpu';
import { buildXtermTheme, monoStack } from './xterm-theme';

export function baseTerminalOptions(o: {
  fontMono: string;
  fontSize: number;
  windowsPty: WindowsPtyInfo | undefined;
}): ITerminalOptions {
  return {
    fontFamily: terminalFontFamily() ?? monoStack(o.fontMono),
    fontSize: o.fontSize,
    // Must be 1.0 so box-drawing characters (│ ┌ └) connect vertically; extra
    // leading breaks them into dashes.
    lineHeight: 1.0,
    // A fallback-face glyph wider than the cell (✔ ⏺ from the symbol font) is scaled into it
    // instead of overlapping its neighbour.
    rescaleOverlappingGlyphs: true,
    cursorBlink: true,
    // xterm's default ring is 1000 lines — roughly eight seconds of a working agent.
    // Once the ring is full, a scrolled-up reader is pushed AWAY from the bottom on
    // every trimmed line, so a small ring turns ordinary reading into a runaway scroll.
    scrollback: 10000,
    // Canvas stays transparent; the configurable surface lives on the `.termwrap` container.
    theme: buildXtermTheme(),
    allowProposedApi: true,
    ...windowsPtyOptions(o.windowsPty),
    // Transparent so the container surface and animated app backdrop show through.
    allowTransparency: true,
  };
}

/**
 * Gives an opened terminal its WebGL slot and reports its context loss. Returns the release, which
 * drops the listener and frees the slot. Call after `term.open`: the listener needs the canvas.
 */
export function attachTerminalGpu(
  term: Terminal,
  opts: { visible: boolean; onFontRefresh?: () => void },
): () => void {
  const reportLoss = () => terminalGpu.reportLoss(term);
  // `webglcontextlost` doesn't bubble out of xterm's canvas; capture still sees it.
  term.element?.addEventListener('webglcontextlost', reportLoss, true);
  const release = terminalGpu.register(term, opts.onFontRefresh, { visible: opts.visible });
  return () => {
    term.element?.removeEventListener('webglcontextlost', reportLoss, true);
    release();
  };
}
