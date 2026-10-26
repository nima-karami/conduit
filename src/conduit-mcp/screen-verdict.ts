import type { ScreenPatterns } from './adapters';
import type { ScreenVerdict } from './types';

/** Visible viewport rows. */
export interface ScreenSnapshot {
  lines: readonly string[];
  cursorY: number;
  cursorX: number;
  /**
   * Style mask of the cursor row, aligned char-for-char with `lines[cursorY]`: `STYLE_DIM` for a
   * faint (SGR 2) cell, `STYLE_PLAIN` otherwise. Only the cursor row: nothing else is stripped.
   */
  cursorRowStyles: string;
}

export const STYLE_PLAIN = '.';
export const STYLE_DIM = 'd';

/** Cursor row + 2 above: a notice can wrap. */
export const NOTICE_ECHO_ROWS = 3;

const squash = (s: string) => s.replace(/\s/g, '');

// The last match wins so a menu row below the input is the one tested (spec
// 2026-10-26-conduit-mcp-cursor §3.4).
function findInputRow(
  lines: readonly string[],
  cursorY: number,
  loc: NonNullable<ScreenPatterns['inputRow']>,
): number {
  for (let y = cursorY; y >= Math.max(0, cursorY - loc.maxAbove); y--) {
    if (loc.pattern.test(lines[y] ?? '')) return y;
  }
  return -1;
}

/**
 * Row `y` with a placeholder dropped. Narrowed to what was measured
 * (docs/runs/2026-10-26-conduit-mcp/placeholder-cells.md): one faint run (gaps may be plain
 * whitespace — Claude's first paint) from the cursor to the end of the row, after a bare prompt.
 * A placeholder parks the cursor at its start; typed text, a paste chip or an image chip never do,
 * so off the cursor row nothing is dropped.
 * Char index = cell index here because the prompt glyphs before the run are single-width.
 */
function inputText(patterns: ScreenPatterns, s: ScreenSnapshot, y: number): string {
  const row = s.lines[y] ?? '';
  if (patterns.placeholder !== 'dim' || y !== s.cursorY) return row;
  const start = s.cursorRowStyles.indexOf(STYLE_DIM);
  if (start < 0 || s.cursorX !== start) return row;
  for (let i = start; i < row.length; i += 1) {
    if (s.cursorRowStyles[i] !== STYLE_DIM && !/\s/.test(row[i])) return row;
  }
  const head = row.slice(0, start);
  return patterns.emptyInput.some((re) => re.test(head)) ? head : row;
}

// Blocking matches the whole viewport, because Claude's permission dialog sits ~15 rows below the
// cursor; empty-input matches one row only, so old prompt text can't count (plan, S0 measured).
// That row is the cursor's, unless the adapter parks the cursor away from its input box.
export function screenVerdict(
  patterns: ScreenPatterns | null,
  s: ScreenSnapshot,
  expectNotice?: string,
): ScreenVerdict {
  if (!patterns) return 'unknown';
  if (s.lines.some((l) => patterns.blocking.some((re) => re.test(l)))) return 'blocking';

  let rowY = s.cursorY;
  let echoFrom = Math.max(0, s.cursorY - (NOTICE_ECHO_ROWS - 1));
  let echoTo = s.cursorY + 1;
  if (patterns.inputRow) {
    rowY = findInputRow(s.lines, s.cursorY, patterns.inputRow);
    if (rowY < 0) return 'unknown';
    echoFrom = rowY;
    echoTo = rowY + NOTICE_ECHO_ROWS;
  }

  if (expectNotice !== undefined) {
    const rows = s.lines.slice(echoFrom, echoTo);
    if (squash(rows.join('')).includes(squash(expectNotice))) return 'notice-echoed';
  }
  if (s.lines[rowY] === undefined) return 'unknown';
  const row = inputText(patterns, s, rowY);
  return patterns.emptyInput.some((re) => re.test(row)) ? 'empty-input' : 'unknown';
}
