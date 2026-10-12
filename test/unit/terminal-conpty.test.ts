import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import type { ReplayRun, TermGeometry, WindowsPtyInfo } from '../../src/protocol';
import {
  matchConhostCellWidths,
  sizeDiffers,
  windowsPtyOptions,
  writeReplay,
} from '../../webview/terminal-conpty';

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

// Measured on cmd.exe over inbox ConPTY 22621: after a 30→12→30-row resize it repainted its
// 12-row viewport from the home position and erased below, never scrolling history back down.
const conptyGrowRepaint = (screen: string[]) =>
  `\x1b[H${screen.map((l) => `${l}\x1b[K`).join('\r\n')}\x1b[J`;

const LINES = Array.from({ length: 40 }, (_, i) => `RUN1-${i + 1}`);
const notOnce = (lines: string[]) => LINES.filter((l) => lines.filter((x) => x === l).length !== 1);

/** Win10 19045's ConPTY reflows the live screen itself, so xterm turns its own reflow off. */
const OLD_CONPTY: WindowsPtyInfo = { backend: 'conpty', buildNumber: 19045 };

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

describe('writeReplay on a ConPTY that reflows by itself', () => {
  const oldConptyTerm = (g: TermGeometry) =>
    new Terminal({ ...g, allowProposedApi: true, ...windowsPtyOptions(OLD_CONPTY) });

  it('still keeps every row of a wider recording intact after the fit', async () => {
    const term = oldConptyTerm(PANE);
    await replay(term);
    const lines = logicalLines(term);
    for (const row of [...frameA.rows, ...frameB.rows]) expect(lines).toContain(row);
    term.dispose();
  });

  it('puts the real windowsPty back once the replay has been fit', async () => {
    const term = oldConptyTerm(PANE);
    const real = term.options.windowsPty;
    await replay(term);
    expect(term.options.windowsPty).toBe(real);
    term.dispose();
  });

  it('keeps ConPTY grow semantics for a taller recorded run', async () => {
    const SHORT = { cols: 40, rows: 12 };
    const TALL = { cols: 40, rows: 30 };
    const history = `${LINES.join('\r\n')}\r\n`;
    const repaint = conptyGrowRepaint([...LINES.slice(-11), '']);
    const term = oldConptyTerm(SHORT);
    await new Promise<void>((resolve) =>
      writeReplay(
        term,
        history + repaint,
        [
          { length: history.length, geometry: SHORT },
          { length: repaint.length, geometry: TALL },
        ],
        () => {},
        () => {
          term.resize(TALL.cols, TALL.rows);
          resolve();
        },
      ),
    );
    expect(notOnce(logicalLines(term))).toEqual([]);
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

describe('windowsPtyOptions', () => {
  it("passes the host's pseudoconsole through as xterm's windowsPty", () => {
    expect(windowsPtyOptions({ backend: 'conpty', buildNumber: 22621 })).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 22621 },
    });
    expect(windowsPtyOptions({ backend: 'winpty', buildNumber: 19045 })).toEqual({
      windowsPty: { backend: 'winpty', buildNumber: 19045 },
    });
  });

  it('sets nothing off Windows or without a host', () => {
    expect(windowsPtyOptions(undefined)).toEqual({});
  });

  async function shrinkGrow(info: WindowsPtyInfo | undefined): Promise<string[]> {
    const term = new Terminal({
      cols: 40,
      rows: 30,
      allowProposedApi: true,
      ...windowsPtyOptions(info),
    });
    await write(term, `${LINES.join('\r\n')}\r\n`);
    term.resize(40, 12);
    term.resize(40, 30);
    await write(term, conptyGrowRepaint([...LINES.slice(-11), '']));
    const lines = logicalLines(term);
    term.dispose();
    return lines;
  }

  it('keeps every line exactly once across a ConPTY shrink and grow', async () => {
    expect(notOnce(await shrinkGrow({ backend: 'conpty', buildNumber: 22621 }))).toEqual([]);
  });

  it('is needed: without it the grow pulls history under the repaint', async () => {
    expect(notOnce(await shrinkGrow(undefined))).not.toEqual([]);
  });
});
