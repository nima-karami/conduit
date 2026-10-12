import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import type { TermGeometry } from '../../src/protocol';
import {
  coldReplay,
  RELAUNCH_MARKER,
  restoreScrollback,
  spawnPrelude,
} from '../../src/scrollback-persistence';
import { ScrollbackStore } from '../../src/scrollback-store';
import { writeReplay } from '../../webview/terminal-conpty';

const COLS = 60;
const ROWS = 12;
const SENTINEL = 'LAST-SCREEN-SENTINEL';
// What ConPTY emits first on spawn; it erases the viewport in place.
const CONPTY_SPAWN_CLEAR = '\x1b[2J\x1b[H';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const lines = (term: Terminal): string[] => {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out;
};

/**
 * The host's whole cold-start byte stream through a real xterm. `termRows` is what the terminal
 * actually has when the prelude lands: the pane's rows, or — when the pane was hidden as the
 * replay ended and could not fit back — the history's recorded rows.
 */
async function relaunchOver(
  history: string,
  { recordedRows, termRows = ROWS }: { recordedRows?: number; termRows?: number } = {},
): Promise<string[]> {
  const term = new Terminal({ cols: COLS, rows: termRows, allowProposedApi: true });
  const geometry = recordedRows ? { cols: COLS, rows: recordedRows } : undefined;
  await write(term, coldReplay([geometry ? { data: history, geometry } : { data: history }]).data);
  await write(
    term,
    spawnPrelude('win32', ROWS, { relaunched: true, replayed: true, recordedRows }),
  );
  await write(term, CONPTY_SPAWN_CLEAR);
  const out = lines(term);
  term.dispose();
  return out;
}

// Longer than the marker, so a marker written over one of them leaves a visible tail.
const olderLines = Array.from({ length: ROWS + 10 }, (_, i) =>
  `old history line ${i} `.padEnd(40, '.'),
);

describe('cold relaunch prelude (real xterm)', () => {
  it("keeps the dead session's last screen above ConPTY's spawn clear", async () => {
    const out = await relaunchOver(`${[...olderLines, SENTINEL].join('\r\n')}\r\n`);
    expect(out).toContain(SENTINEL);
    for (const l of olderLines.slice(-(ROWS - 1))) expect(out).toContain(l);
  });

  it('puts the relaunch marker on a line of its own, below the history', async () => {
    const out = await relaunchOver(`${[...olderLines, SENTINEL].join('\r\n')}\r\n`);
    const marker = '— session relaunched —';
    expect(RELAUNCH_MARKER).toContain(marker);
    const markerLines = out.filter((l) => l.includes(marker));
    expect(markerLines).toEqual([marker]);
    expect(out.indexOf(marker)).toBeGreaterThan(out.indexOf(SENTINEL));
    expect(out.indexOf(SENTINEL)).toBeGreaterThanOrEqual(0);
  });

  it('holds when the history ends mid-line inside a dead TUI on the alternate screen', async () => {
    const history = `${olderLines.join('\r\n')}\r\n${SENTINEL}\x1b[?1049h\x1b[3;5rTUI frame`;
    const out = await relaunchOver(history);
    expect(out).toContain(SENTINEL);
    expect(out.some((l) => l.includes('TUI frame'))).toBe(false);
    expect(out).toContain('— session relaunched —');
  });

  it('still lifts the last screen clear when the terminal is stuck at taller recorded rows', async () => {
    const recordedRows = ROWS + 8;
    const tall = Array.from({ length: recordedRows + 10 }, (_, i) => `tall line ${i}`);
    const out = await relaunchOver(`${[...tall, SENTINEL].join('\r\n')}\r\n`, {
      recordedRows,
      termRows: recordedRows,
    });
    expect(out).toContain(SENTINEL);
    for (const l of tall.slice(-(recordedRows - 1))) expect(out).toContain(l);
  });
});

/** Rows of the buffer with soft-wrapped continuations joined back on. */
const logicalLines = (term: Terminal): string[] => {
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
};

const SID = 's1';
// ConPTY's first bytes for every new child, then whatever the run printed.
const runOutput = (tag: string, n: number, prompt: string) =>
  `\x1b[?25l\x1b[2J\x1b[m\x1b[H${Array.from({ length: n }, (_, i) => `${tag}-${i}`).join('\r\n')}\r\n${prompt}`;

/**
 * One app run of the host, driven the way main.ts drives it: each `coldStart` is a fresh pane
 * over a new child — replay (the renderer writes each run at its size and fits back), the spawn
 * prelude through `ScrollbackStore.show`, then the child's output. `blob` is what the
 * previous app run left on disk.
 */
function appRun(blob: string | undefined) {
  let saved = blob ?? '';
  let term: Terminal | null = null;
  const store = new ScrollbackStore(
    (_id, b) => {
      saved = b;
    },
    { send: (_id, data) => term?.write(data), recording: () => true },
  );
  return {
    store,
    blob: () => {
      store.flush(SID);
      return saved;
    },
    async coldStart(pane: TermGeometry, output: string): Promise<Terminal> {
      const t = new Terminal({ ...pane, allowProposedApi: true });
      term = t;
      const fitToPane = () => t.resize(pane.cols, pane.rows);
      const replay = store.replayForColdStart(SID, () => restoreScrollback(blob)?.segments);
      const replayed = !!replay?.data;
      if (replay?.data) {
        await new Promise<void>((resolve) =>
          writeReplay(t, replay.data, replay.runs, fitToPane, () => {
            fitToPane();
            resolve();
          }),
        );
      }
      const recordedRows = replay?.runs.findLast((r) => r.geometry)?.geometry?.rows;
      store.show(
        SID,
        spawnPrelude('win32', pane.rows, { relaunched: true, replayed, recordedRows }),
        pane,
      );
      await write(t, output);
      store.append(SID, output, pane);
      return t;
    },
  };
}

/** A single cold start in a new app run; returns what it left on disk and the terminal it drew. */
async function relaunchedAppRun(blob: string | undefined, pane: TermGeometry, output: string) {
  const run = appRun(blob);
  const term = await run.coldStart(pane, output);
  return { blob: run.blob(), term };
}

describe('cold relaunch across app runs (real xterm, real ring round-trip)', () => {
  const MARKER = '— session relaunched —';

  it("keeps run 1's last screen and both markers, in order, two relaunches later", async () => {
    const r1 = await relaunchedAppRun(
      undefined,
      { cols: 60, rows: 12 },
      runOutput('RUN1', 30, 'run1-prompt>'),
    );
    const r2 = await relaunchedAppRun(
      r1.blob,
      { cols: 50, rows: 10 },
      runOutput('RUN2', 20, 'run2-prompt>'),
    );
    const r3 = await relaunchedAppRun(
      r2.blob,
      { cols: 70, rows: 14 },
      runOutput('RUN3', 5, 'run3-prompt>'),
    );
    const out = logicalLines(r3.term);
    const at = (l: string) => out.indexOf(l);
    for (let i = 18; i < 30; i++) expect(out).toContain(`RUN1-${i}`);
    expect(out).toContain('run1-prompt>');
    expect(out).toContain('RUN2-19');
    const markers = out.flatMap((l, i) => (l === MARKER ? [i] : []));
    expect(out.filter((l) => l.includes(MARKER))).toEqual([MARKER, MARKER]);
    expect(at('run1-prompt>')).toBeLessThan(markers[0]);
    expect(markers[0]).toBeLessThan(at('RUN2-19'));
    expect(at('run2-prompt>')).toBeLessThan(markers[1]);
    expect(markers[1]).toBeLessThan(at('RUN3-4'));
  });

  it("keeps the old prompt whole when the new pane is narrower (it isn't the cursor's row)", async () => {
    const prompt = 'C:/Users/someone/a/fairly/long/project/path>';
    const r1 = await relaunchedAppRun(
      undefined,
      { cols: 80, rows: 12 },
      runOutput('OLD', 20, prompt),
    );
    const r2 = await relaunchedAppRun(
      r1.blob,
      { cols: 20, rows: 12 },
      runOutput('NEW', 2, 'new-prompt>'),
    );
    expect(logicalLines(r2.term)).toContain(prompt);
  });

  it('keeps run 1 through a relaunch inside one app run, then a cold start', async () => {
    const first = appRun(undefined);
    await first.coldStart({ cols: 60, rows: 12 }, runOutput('RUN1', 30, 'run1-prompt>'));
    const inRun = await first.coldStart(
      { cols: 60, rows: 12 },
      runOutput('RUN2', 5, 'run2-prompt>'),
    );
    const shown = logicalLines(inRun);
    expect(shown).toContain('RUN1-29');
    expect(shown).toContain('run1-prompt>');
    expect(shown.indexOf('run1-prompt>')).toBeLessThan(shown.indexOf(MARKER));

    const next = await relaunchedAppRun(
      first.blob(),
      { cols: 70, rows: 14 },
      runOutput('RUN3', 3, 'run3>'),
    );
    const out = logicalLines(next.term);
    for (let i = 18; i < 30; i++) expect(out).toContain(`RUN1-${i}`);
    const markers = out.flatMap((l, i) => (l === MARKER ? [i] : []));
    expect(out.filter((l) => l.includes(MARKER))).toEqual([MARKER, MARKER]);
    expect(out.indexOf('run1-prompt>')).toBeLessThan(markers[0]);
    expect(markers[0]).toBeLessThan(out.indexOf('RUN2-4'));
    expect(out.indexOf('run2-prompt>')).toBeLessThan(markers[1]);
  });
});
