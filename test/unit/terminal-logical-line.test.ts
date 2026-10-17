import { describe, expect, it } from 'vitest';
import { detectPathTokens, MAX_LOGICAL_LINE } from '../../webview/terminal-links';
import {
  type BufferLike,
  buildLogicalLine,
  offsetAtCell,
  toBufferRange,
} from '../../webview/terminal-logical-line';

/** A fake xterm buffer: each row is padded to `cols` like xterm's untrimmed translateToString. */
function fakeBuffer(rows: Array<{ text: string; wrapped?: boolean }>, cols: number): BufferLike {
  return {
    length: rows.length,
    getLine(y) {
      const row = rows[y];
      if (!row) return undefined;
      const full = row.text.padEnd(cols, ' ');
      return {
        isWrapped: row.wrapped === true,
        translateToString: (trimRight?: boolean) => (trimRight ? full.replace(/\s+$/, '') : full),
      };
    },
  };
}

describe('buildLogicalLine', () => {
  const cols = 10;
  const buf = fakeBuffer(
    [
      { text: 'prompt>' },
      { text: 'G:/work/re' },
      { text: 'poA/src/ut', wrapped: true },
      { text: 'il/a.ts', wrapped: true },
      { text: 'next' },
    ],
    cols,
  );

  it('joins a row with its wrapped continuations from any row of the group', () => {
    const fromTop = buildLogicalLine(buf, 1, cols);
    const fromMiddle = buildLogicalLine(buf, 2, cols);
    const fromLast = buildLogicalLine(buf, 3, cols);
    expect(fromTop?.text).toBe('G:/work/repoA/src/util/a.ts');
    expect(fromTop?.firstRow).toBe(1);
    expect(fromTop?.rowStarts).toEqual([0, 10, 20]);
    expect(fromMiddle).toEqual(fromTop);
    expect(fromLast).toEqual(fromTop);
  });

  it('reads non-last rows untrimmed', () => {
    const spaced = fakeBuffer([{ text: 'abc def  ' }, { text: 'x.ts', wrapped: true }], cols);
    expect(buildLogicalLine(spaced, 0, cols)?.text).toBe('abc def   x.ts');
  });

  it('returns null past MAX_LOGICAL_LINE', () => {
    const wide = 100;
    const rows = Array.from({ length: MAX_LOGICAL_LINE / wide + 1 }, (_, i) => ({
      text: 'x'.repeat(wide),
      wrapped: i > 0,
    }));
    expect(buildLogicalLine(fakeBuffer(rows, wide), 3, wide)).toBeNull();
  });

  it('maps a token spanning the wrap to a two-row range', () => {
    const c80 = 80;
    const head = 'x'.repeat(78);
    const b = fakeBuffer(
      [
        { text: 'prompt>' },
        { text: `${head}ab` },
        { text: 'cdefgh', wrapped: true },
        { text: 'tail', wrapped: true },
      ],
      c80,
    );
    const ll = buildLogicalLine(b, 2, c80);
    expect(ll).not.toBeNull();
    if (!ll) return;
    expect(ll.firstRow).toBe(1);
    // `abcde`: the last two cells of the group's first row and the first three of its second.
    // xterm ranges are 1-based (x and buffer line) and end-inclusive.
    const tokenStart = ll.rowStarts[0] + 78;
    expect(ll.text.slice(tokenStart, tokenStart + 5)).toBe('abcde');
    expect(toBufferRange(ll, tokenStart, tokenStart + 5)).toEqual({
      start: { x: 79, y: ll.firstRow + 1 },
      end: { x: 3, y: ll.firstRow + 2 },
    });
  });

  it('an unwrapped row is its own line', () => {
    const ll = buildLogicalLine(buf, 0, cols);
    expect(ll).toEqual({ text: 'prompt>', firstRow: 0, rowStarts: [0], cols });
    expect(toBufferRange(ll as NonNullable<typeof ll>, 0, 6)).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 6, y: 1 },
    });
  });

  it('a row outside the buffer is null', () => {
    expect(buildLogicalLine(buf, 99, cols)).toBeNull();
  });
});

// Plan T9.2 (row 52): Claude Code's Ink UI hard-wraps — a full row, no isWrapped.
describe('buildLogicalLine — Ink hard-wrap heuristic', () => {
  const cols = 10;

  it('a full row ending in a path char joins a next row that starts (after ≤ 2 spaces) with one', () => {
    const buf = fakeBuffer([{ text: 'G:/work/re' }, { text: '  po/x.ts' }, { text: 'next' }], cols);
    const ll = buildLogicalLine(buf, 0, cols);
    expect(ll?.text).toBe('G:/work/repo/x.ts');
    expect(ll?.rowStarts).toEqual([0, 10]);
    expect(ll?.rowIndents).toEqual([0, 2]);
    expect(buildLogicalLine(buf, 1, cols)).toEqual(ll);
    // The joined token's range starts past the indent on the second row.
    expect(toBufferRange(ll as NonNullable<typeof ll>, 0, 17)).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 9, y: 2 },
    });
    expect(toBufferRange(ll as NonNullable<typeof ll>, 13, 17)).toEqual({
      start: { x: 6, y: 2 },
      end: { x: 9, y: 2 },
    });
  });

  it('offsetAtCell: a cell in the Ink indent is on no offset, never the row above', () => {
    const buf = fakeBuffer([{ text: 'G:/work/re' }, { text: '  po/x.ts' }], cols);
    const ll = buildLogicalLine(buf, 0, cols) as NonNullable<ReturnType<typeof buildLogicalLine>>;
    expect(offsetAtCell(ll, 1, 0)).toBeNull();
    expect(offsetAtCell(ll, 1, 1)).toBeNull();
    expect(offsetAtCell(ll, 1, 2)).toBe(10);
    expect(offsetAtCell(ll, 0, 4)).toBe(4);
    expect(offsetAtCell(ll, 2, 0)).toBeNull();
  });

  it('a row shorter than cols never joins', () => {
    const buf = fakeBuffer([{ text: 'G:/work/r' }, { text: 'epoA/x.ts' }], cols);
    expect(buildLogicalLine(buf, 0, cols)?.text).toBe('G:/work/r');
    // …and a full row ending in a TUI frame char never joins either.
    const framed = fakeBuffer([{ text: '│ G:/w/re│' }, { text: '│ next   │' }], cols);
    expect(buildLogicalLine(framed, 0, cols)?.text).toBe('│ G:/w/re│');
  });

  it('a full row ending in a non-path char never joins', () => {
    const buf = fakeBuffer([{ text: 'G:/work/r:' }, { text: 'epoA/x.ts' }], cols);
    expect(buildLogicalLine(buf, 0, cols)?.text).toBe('G:/work/r:');
  });

  it('a next row that does not start with a path char (or is indented > 2) never joins', () => {
    expect(
      buildLogicalLine(fakeBuffer([{ text: 'G:/work/re' }, { text: '"poA/x.ts' }], cols), 0, cols)
        ?.text,
    ).toBe('G:/work/re');
    expect(
      buildLogicalLine(fakeBuffer([{ text: 'G:/work/re' }, { text: '   poA/x.ts' }], cols), 0, cols)
        ?.text,
    ).toBe('G:/work/re');
    expect(
      buildLogicalLine(fakeBuffer([{ text: 'G:/work/re' }, { text: '' }], cols), 0, cols)?.text,
    ).toBe('G:/work/re');
  });

  it.each(['-', '=', '_', '~', '#', '.'])(
    'a full-width %j rule never joins the next row, nor a row onto it',
    (ch) => {
      const w = 24;
      const below = fakeBuffer([{ text: ch.repeat(w) }, { text: 'src/foo.ts:3:1 error' }], w);
      const ll = buildLogicalLine(below, 1, w);
      expect(ll?.text).toBe('src/foo.ts:3:1 error');
      expect(detectPathTokens(ll?.text ?? '', '/w').map((t) => t.raw)).toEqual(['src/foo.ts']);
      const rule = ch.repeat(cols);
      const above = fakeBuffer([{ text: 'G:/w/src/a' }, { text: rule }], cols);
      expect(buildLogicalLine(above, 0, cols)?.text).toBe('G:/w/src/a');
      const indented = fakeBuffer([{ text: `  ${ch.repeat(cols - 2)}` }, { text: 'x/y.ts' }], cols);
      expect(buildLogicalLine(indented, 1, cols)?.text).toBe('x/y.ts');
    },
  );

  it('chains over several hard-wrapped rows, still under MAX_LOGICAL_LINE', () => {
    const rows = [{ text: 'G:/aaaaaaa' }, { text: 'bbbbbbbbbb' }, { text: 'cc/x.ts' }];
    expect(buildLogicalLine(fakeBuffer(rows, cols), 2, cols)?.text).toBe(
      'G:/aaaaaaabbbbbbbbbbcc/x.ts',
    );
    const long = Array.from({ length: MAX_LOGICAL_LINE / cols + 2 }, () => ({
      text: 'aaaaaaaaaa',
    }));
    expect(buildLogicalLine(fakeBuffer(long, cols), 0, cols)).toBeNull();
  });
});
