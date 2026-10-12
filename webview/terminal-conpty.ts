import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ReplayRun, TermGeometry } from '../src/protocol';

// Structural, so the real terminal and the headless one in tests both fit.
interface ReplayTarget {
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

/**
 * Write a cold replay run by run, each at the size it was recorded at (a run without one at the
 * pane's, via `fitToPane`), then `done` — which fits back to the pane. ConPTY output is absolutely
 * addressed, so replayed at any other width it re-wraps and clamps into garbage; at its own width
 * it lands as recorded and xterm reflows it on the way back. Every size change rides the write
 * queue: xterm runs a write's callback before parsing the next write, so output queued before the
 * replay never sees a recorded size, and output queued after it sees only what `done` leaves.
 */
export function writeReplay(
  term: ReplayTarget,
  data: string,
  runs: readonly ReplayRun[],
  fitToPane: () => void,
  done: () => void,
): void {
  let at = 0;
  for (const run of runs) {
    const g = run.geometry;
    term.write('', g ? () => term.resize(g.cols, g.rows) : fitToPane);
    term.write(data.slice(at, at + run.length));
    at += run.length;
  }
  term.write(data.slice(at), done);
}

/** Whether the terminal now differs from the size last given to the host (none given counts). */
export function sizeDiffers(sent: TermGeometry | null, term: TermGeometry): boolean {
  return !sent || sent.cols !== term.cols || sent.rows !== term.rows;
}

interface UnicodeTarget {
  loadAddon(addon: Unicode11Addon): void;
  unicode: { activeVersion: string };
}

/**
 * conhost advances two cells for emoji and wide CJK; xterm's default Unicode 6 tables advance
 * one, so ConPTY's absolute repaints land a cell (then a row) off on any line holding one.
 */
export function matchConhostCellWidths(term: UnicodeTarget): void {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
}
