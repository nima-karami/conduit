import type { ScreenPatterns } from './adapters';
import type { ScreenVerdict } from './types';

/** Visible viewport rows. */
export interface ScreenSnapshot {
  lines: readonly string[];
  cursorY: number;
}

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
  const row = s.lines[rowY];
  if (row !== undefined && patterns.emptyInput.some((re) => re.test(row))) return 'empty-input';
  return 'unknown';
}
