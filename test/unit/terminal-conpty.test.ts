import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import type { ReplayRun, TermGeometry } from '../../src/protocol';
import { matchConhostCellWidths, sizeDiffers, writeReplay } from '../../webview/terminal-conpty';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

/** Logical lines: soft-wrapped rows joined back onto the row they continue. */
function logicalLines(term: Terminal): string[] {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  return out;
}

const PANE = { cols: 20, rows: 10 };
const A = { cols: 30, rows: 6 };
// The later run is wider, so writing every run at the first run's size garbles it too.
const B = { cols: 40, rows: 6 };

/**
 * How ConPTY paints at `g`: five full-width rows placed by absolute cursor position, the cursor
 * parked on the row below (xterm never reflows the cursor's own row — reflowCursorLine), then
 * enough newlines to scroll the frame into history, as later output would.
 */
function conptyFrame(tag: string, g: TermGeometry) {
  const rows = Array.from({ length: 5 }, (_, i) => `${tag}${i}:`.padEnd(g.cols, `${i}`));
  const data = `${rows.map((t, i) => `\x1b[${i + 1};1H${t}`).join('')}\x1b[6;1H${'\r\n'.repeat(g.rows)}`;
  return { rows, data };
}

const frameA = conptyFrame('a', A);
const frameB = conptyFrame('b', B);
const replayData = frameA.data + frameB.data;
const runs: ReplayRun[] = [
  { length: frameA.data.length, geometry: A },
  { length: frameB.data.length, geometry: B },
];

function replay(term: Terminal, onFitToPane = () => {}): Promise<void> {
  return new Promise((resolve) =>
    writeReplay(term, replayData, runs, onFitToPane, () => {
      term.resize(PANE.cols, PANE.rows);
      resolve();
    }),
  );
}

describe('writeReplay', () => {
  it('lands each run intact at its own size, then reflows everything to the pane', async () => {
    const term = new Terminal({ ...PANE, allowProposedApi: true });
    await replay(term);
    expect(term.cols).toBe(PANE.cols);
    const lines = logicalLines(term);
    for (const row of [...frameA.rows, ...frameB.rows]) expect(lines).toContain(row);
    term.dispose();
  });

  it('is needed: the same bytes written at the pane size are garbled', async () => {
    const term = new Terminal({ ...PANE, allowProposedApi: true });
    await write(term, replayData);
    const lines = logicalLines(term);
    const all = [...frameA.rows, ...frameB.rows];
    expect(all.filter((row) => lines.includes(row)).length).toBeLessThan(all.length);
    term.dispose();
  });

  it('keeps recorded sizes off output queued before and after the replay', async () => {
    const term = new Terminal({ ...PANE, allowProposedApi: true });
    const seen: number[] = [];
    term.write('before', () => seen.push(term.cols));
    const replayed = replay(term);
    await write(term, 'after');
    seen.push(term.cols);
    await replayed;
    expect(seen).toEqual([PANE.cols, PANE.cols]);
    term.dispose();
  });

  it('fits to the pane for a run with no recorded size (a v1 file)', async () => {
    const term = new Terminal({ ...A, allowProposedApi: true });
    const order: string[] = [];
    await new Promise<void>((resolve) =>
      writeReplay(
        term,
        'v1 history\r\n',
        [{ length: 12 }],
        () => order.push('fit'),
        () => {
          order.push('done');
          resolve();
        },
      ),
    );
    expect(order).toEqual(['fit', 'done']);
    expect(logicalLines(term)).toContain('v1 history');
    term.dispose();
  });
});

describe('matchConhostCellWidths', () => {
  it.each([
    ['a check-mark emoji', '✅'],
    ['a face emoji', '😀'],
  ])('advances the cursor two cells for %s, as conhost does', async (_label, glyph) => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    matchConhostCellWidths(term);
    await write(term, glyph);
    expect(term.buffer.active.cursorX).toBe(2);
    term.dispose();
  });
});

describe('sizeDiffers', () => {
  it('is true until a size was given, then only for a different size', () => {
    expect(sizeDiffers(null, { cols: 46, rows: 32 })).toBe(true);
    expect(sizeDiffers({ cols: 46, rows: 36 }, { cols: 46, rows: 32 })).toBe(true);
    expect(sizeDiffers({ cols: 45, rows: 32 }, { cols: 46, rows: 32 })).toBe(true);
    expect(sizeDiffers({ cols: 46, rows: 32 }, { cols: 46, rows: 32 })).toBe(false);
  });
});
