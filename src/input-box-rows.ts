import type { ScreenPatterns } from './conduit-mcp/adapters';

/** An adapter's prompt row, for CLIs that draw no rules around their input. */
export interface InputBoxPrompt {
  pattern: RegExp;
  maxAbove: number;
  /** A dialog on screen replaces the input box. */
  blocking: readonly RegExp[];
  /** First row of a submitted prompt the CLI echoes into history (ScreenPatterns.promptEcho). */
  echo?: RegExp;
}

/** A buffer row's text and the styles the rules read. `text` may be computed on first read. */
export interface RowView {
  readonly text: string;
  /** Column 0's background as `<colorMode>:<color>`; '' for the default background. */
  bg0: string;
  dim0: boolean;
  /** The last column's background, same form. */
  bgLast: string;
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
  return screen && row
    ? {
        ...row,
        blocking: screen.blocking,
        ...(screen.promptEcho ? { echo: screen.promptEcho } : {}),
      }
    : undefined;
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

type RowAt = (y: number) => RowView | undefined;

function ruledTop(rowAt: RowAt, cursorRow: number, o: InputBoxOpts) {
  let top = -1;
  for (let y = cursorRow; y >= Math.max(0, cursorRow - o.rows); y -= 1) {
    if (isRule(rowAt(y)?.text, o.cols)) {
      top = y;
      break;
    }
  }
  if (top < 0 || top === cursorRow || !CLAUDE_PROMPT.test(rowAt(top + 1)?.text ?? '')) return null;
  for (let y = cursorRow + 1; y <= cursorRow + o.rows; y += 1) {
    const text = rowAt(y)?.text;
    if (text === undefined) return null;
    if (isRule(text, o.cols)) return top;
  }
  return null;
}

function promptTop(rowAt: RowAt, cursorRow: number, o: InputBoxOpts, p: InputBoxPrompt) {
  for (let y = Math.max(0, cursorRow - o.rows + 1); y < cursorRow + o.rows; y += 1) {
    const text = rowAt(y)?.text;
    if (text === undefined) break;
    if (p.blocking.some((re) => re.test(text))) return null;
  }
  for (let y = cursorRow; y >= Math.max(0, cursorRow - p.maxAbove); y -= 1) {
    const row = rowAt(y);
    // An echoed prompt (dim, ScreenPatterns.promptEcho) has the same glyph as the live row; taking
    // it for the box would unlink the agent output under it.
    if (row && !row.dim0 && p.pattern.test(row.text)) return y;
  }
  return null;
}

/**
 * First buffer row of the live input box, or null when none is on screen. Everything from it to the
 * end of the buffer is the CLI's own chrome, never agent output.
 * Spec docs/specs/2026-10-27-input-box-links.md §2.
 */
export function inputBoxTop(rowAt: RowAt, cursorRow: number, opts: InputBoxOpts): number | null {
  return (
    ruledTop(rowAt, cursorRow, opts) ??
    (opts.prompt ? promptTop(rowAt, cursorRow, opts, opts.prompt) : null)
  );
}

// Claude paints a submitted prompt's rows, `❯` (or bash mode's `!`) row first, on one background
// that spans the whole row; its live box and its output (markdown quotes become `▎`) have none, and a
// shell theme's prompt segment stops short of the row end. Measured: fixtures/input-box-links/claude-*.
const CLAUDE_ECHO = /^[❯!]\s/;
// A typed prompt can run long; past this the walk gives up and the row stays linked.
const ECHO_MAX_ROWS = 500;

/**
 * Whether row `y` belongs to a prompt the user submitted, echoed into history: the user's text,
 * not agent output. Claude's shape is checked in every terminal; `echo` is the adapter's.
 */
export function inPromptEcho(rowAt: RowAt, y: number, echo?: RegExp): boolean {
  const here = rowAt(y);
  if (!here) return false;
  const floor = Math.max(0, y - ECHO_MAX_ROWS);
  if (here.bg0) {
    for (let r = y; r >= floor; r -= 1) {
      const row = rowAt(r);
      if (row?.bg0 !== here.bg0) break;
      if (row.bgLast === row.bg0 && CLAUDE_ECHO.test(row.text)) return true;
    }
  }
  if (!echo || !here.text.trim()) return false;
  // Codex leaves a prompt's paragraphs separated by blank rows, every row after the first indented;
  // its replies start at column 0 (`•`), which ends the walk. Measured: codex-echo-paragraphs.
  for (let r = y; r >= floor; r -= 1) {
    const row = rowAt(r);
    if (!row) return false;
    if (!row.text.trim()) continue;
    if (row.dim0 && echo.test(row.text)) return true;
    if (!/^\s/.test(row.text)) return false;
  }
  return false;
}
