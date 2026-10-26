import type { ScreenPatterns } from './adapters';
import type { ScreenVerdict } from './types';

/** Visible viewport rows. */
export interface ScreenSnapshot {
  lines: readonly string[];
  cursorY: number;
  /**
   * Per-line style masks aligned char-for-char with `lines`: `STYLE_DIM` for a faint (SGR 2) cell,
   * `STYLE_PLAIN` otherwise. Absent ⇒ styles unknown, and only the text patterns apply.
   */
  styles?: readonly string[];
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
 * The row's real text: CLIs draw their placeholders and suggested prompts faint in the input row
 * (docs/runs/2026-10-26-conduit-mcp/placeholder-cells.md), so those cells are not input.
 */
function realText(patterns: ScreenPatterns, s: ScreenSnapshot, y: number): string {
  const line = s.lines[y] ?? '';
  const mask = s.styles?.[y];
  if (patterns.placeholder !== 'dim' || mask === undefined) return line;
  let out = '';
  for (let i = 0; i < line.length; i += 1) if (mask[i] !== STYLE_DIM) out += line[i];
  return out;
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
    let rows = '';
    for (let y = echoFrom; y < echoTo; y += 1) rows += realText(patterns, s, y);
    if (squash(rows).includes(squash(expectNotice))) return 'notice-echoed';
  }
  if (s.lines[rowY] === undefined) return 'unknown';
  const row = realText(patterns, s, rowY);
  if (patterns.emptyInput.some((re) => re.test(row))) return 'empty-input';
  // The placeholder text patterns also match the same words typed for real, so they only stand in
  // when the snapshot can't tell faint from typed.
  const stylesKnown = patterns.placeholder !== undefined && s.styles !== undefined;
  if (!stylesKnown && patterns.placeholderText?.some((re) => re.test(row))) return 'empty-input';
  return 'unknown';
}
