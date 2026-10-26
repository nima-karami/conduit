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

/**
 * The cursor row with a placeholder dropped. Narrowed to what was measured
 * (docs/runs/2026-10-26-conduit-mcp/placeholder-cells.md): one faint run (gaps may be plain
 * whitespace — Claude's first paint) from the cursor to the end of the row, after a bare prompt.
 * A placeholder parks the cursor at its start; typed text, a paste chip or an image chip never do.
 * Char index = cell index here because the prompt glyphs before the run are single-width.
 */
function inputRow(patterns: ScreenPatterns, s: ScreenSnapshot): string {
  const row = s.lines[s.cursorY] ?? '';
  if (patterns.placeholder !== 'dim') return row;
  const start = s.cursorRowStyles.indexOf(STYLE_DIM);
  if (start < 0 || s.cursorX !== start) return row;
  for (let i = start; i < row.length; i += 1) {
    if (s.cursorRowStyles[i] !== STYLE_DIM && !/\s/.test(row[i])) return row;
  }
  const head = row.slice(0, start);
  return patterns.emptyInput.some((re) => re.test(head)) ? head : row;
}

// Blocking matches the whole viewport, because Claude's permission dialog sits ~15 rows below the
// cursor; empty-input matches the cursor row only, so old prompt text can't count (plan, S0
// measured).
export function screenVerdict(
  patterns: ScreenPatterns | null,
  s: ScreenSnapshot,
  expectNotice?: string,
): ScreenVerdict {
  if (!patterns) return 'unknown';
  if (s.lines.some((l) => patterns.blocking.some((re) => re.test(l)))) return 'blocking';
  if (expectNotice !== undefined) {
    const rows = s.lines.slice(Math.max(0, s.cursorY - (NOTICE_ECHO_ROWS - 1)), s.cursorY + 1);
    if (squash(rows.join('')).includes(squash(expectNotice))) return 'notice-echoed';
  }
  if (s.lines[s.cursorY] === undefined) return 'unknown';
  const row = inputRow(patterns, s);
  return patterns.emptyInput.some((re) => re.test(row)) ? 'empty-input' : 'unknown';
}
