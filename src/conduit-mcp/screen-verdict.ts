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
  const row = s.lines[s.cursorY];
  if (row !== undefined && patterns.emptyInput.some((re) => re.test(row))) return 'empty-input';
  return 'unknown';
}
