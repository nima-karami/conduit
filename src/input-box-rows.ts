import type { ScreenPatterns } from './conduit-mcp/adapters';

/** An adapter's prompt row, for CLIs that draw no rules around their input. */
export interface InputBoxPrompt {
  pattern: RegExp;
  maxAbove: number;
  /** A dialog on screen replaces the input box. */
  blocking: readonly RegExp[];
}

export interface InputBoxOpts {
  cols: number;
  /** Viewport height: how far from the cursor a box edge may be. */
  rows: number;
  prompt?: InputBoxPrompt;
}

export function inputBoxPrompt(
  screen: ScreenPatterns | null | undefined,
): InputBoxPrompt | undefined {
  const row = screen?.inputBox ?? screen?.inputRow;
  return screen && row ? { ...row, blocking: screen.blocking } : undefined;
}

// Claude may write a label into its top rule, so the rule only has to fill half the row.
function isRule(text: string | undefined, cols: number): boolean {
  if (!text?.startsWith('─')) return false;
  let n = 0;
  for (const ch of text) if (ch === '─') n += 1;
  return n * 2 >= cols;
}

// `!` is Claude's bash-mode prompt. Requiring a prompt row under the top rule is what keeps a
// full-screen TUI's bordered panes from matching.
const CLAUDE_PROMPT = /^[❯!]\s/;

function ruledTop(rowAt: (y: number) => string | undefined, cursorRow: number, o: InputBoxOpts) {
  let top = -1;
  for (let y = cursorRow; y >= Math.max(0, cursorRow - o.rows); y -= 1) {
    if (isRule(rowAt(y), o.cols)) {
      top = y;
      break;
    }
  }
  if (top < 0 || top === cursorRow || !CLAUDE_PROMPT.test(rowAt(top + 1) ?? '')) return null;
  for (let y = cursorRow + 1; y <= cursorRow + o.rows; y += 1) {
    const text = rowAt(y);
    if (text === undefined) return null;
    if (isRule(text, o.cols)) return top;
  }
  return null;
}

function promptTop(
  rowAt: (y: number) => string | undefined,
  cursorRow: number,
  o: InputBoxOpts,
  p: InputBoxPrompt,
) {
  for (let y = Math.max(0, cursorRow - o.rows + 1); y < cursorRow + o.rows; y += 1) {
    const text = rowAt(y);
    if (text === undefined) break;
    if (p.blocking.some((re) => re.test(text))) return null;
  }
  for (let y = cursorRow; y >= Math.max(0, cursorRow - p.maxAbove); y -= 1) {
    if (p.pattern.test(rowAt(y) ?? '')) return y;
  }
  return null;
}

/**
 * First buffer row of the live input box, or null when none is on screen. Everything from it to the
 * end of the buffer is the CLI's own chrome, never agent output.
 * Spec docs/specs/2026-10-27-input-box-links.md §2.
 */
export function inputBoxTop(
  rowAt: (y: number) => string | undefined,
  cursorRow: number,
  opts: InputBoxOpts,
): number | null {
  return (
    ruledTop(rowAt, cursorRow, opts) ??
    (opts.prompt ? promptTop(rowAt, cursorRow, opts, opts.prompt) : null)
  );
}
