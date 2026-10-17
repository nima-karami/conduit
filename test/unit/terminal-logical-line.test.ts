import { describe, expect, it } from 'vitest';
import { MAX_LOGICAL_LINE } from '../../webview/terminal-links';
import {
  type BufferLike,
  buildLogicalLine,
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
