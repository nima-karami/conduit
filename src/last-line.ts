/**
 * `lastLine` — the one live line every session card shows under its name (conductor
 * decision D6). Derived from the tail of a session's PTY output, so one mechanism serves
 * every card state's subtitle: what the agent is editing, the prompt it is waiting on, or
 * where the shell was left.
 *
 * Pure and dependency-free so it can be exercised on canned terminal bytes.
 */

/** Hard cap on a card subtitle. Long enough for a prompt, short enough never to wrap twice. */
export const LAST_LINE_MAX = 120;

const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x5b; // '['
const OSC = 0x5d; // ']'
const BACKSLASH = 0x5c;

/**
 * Drop ANSI escape sequences from raw PTY output. Hand-scanned rather than
 * regex-matched: a regex for this needs literal control characters, which the linter
 * rejects (and rightly — they are invisible in the source).
 *
 * Handles the three shapes a terminal actually emits: CSI (`ESC [ … final`), OSC
 * (`ESC ] … BEL|ST`, used for titles and the cwd reports src/osc-cwd.ts reads), and
 * two-character escapes. An unterminated sequence at the end of the tail consumes the
 * rest — the buffer is a trailing window, so a truncated head/tail is normal.
 */
export function stripAnsi(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.charCodeAt(i) !== ESC) {
      out += raw[i];
      i += 1;
      continue;
    }
    i += 1;
    const next = raw.charCodeAt(i);
    if (next === CSI) {
      i += 1;
      while (i < raw.length && raw.charCodeAt(i) >= 0x30 && raw.charCodeAt(i) <= 0x3f) i += 1;
      while (i < raw.length && raw.charCodeAt(i) >= 0x20 && raw.charCodeAt(i) <= 0x2f) i += 1;
      i += 1; // final byte
    } else if (next === OSC) {
      i += 1;
      while (i < raw.length) {
        const c = raw.charCodeAt(i);
        if (c === BEL) {
          i += 1;
          break;
        }
        if (c === ESC && raw.charCodeAt(i + 1) === BACKSLASH) {
          i += 2;
          break;
        }
        i += 1;
      }
    } else if (next >= 0x20 && next <= 0x2f) {
      // Intermediate byte(s) then a final: `ESC ( B` and friends (charset designation).
      while (i < raw.length && raw.charCodeAt(i) >= 0x20 && raw.charCodeAt(i) <= 0x2f) i += 1;
      i += 1;
    } else {
      i += 1; // two-character escape
    }
  }
  return out;
}

/** Replace the control characters that survive ANSI stripping; tabs become spaces. */
function printable(line: string): string {
  let out = '';
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09) out += ' ';
    else if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * The last non-empty line of a PTY tail, ANSI-stripped, collapsed and capped at
 * {@link LAST_LINE_MAX}. Returns '' when the tail carries no text (a session that has
 * printed nothing but control sequences shows no subtitle rather than a blank one).
 *
 * A bare CR starts a new line here as well as CRLF: a TUI redraws its status line by
 * returning to column 0, so the text before the CR is a previous frame, not the current one.
 */
export function lastNonEmptyLine(tail: string): string {
  const lines = stripAnsi(tail).split(/\r?\n|\r/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = printable(lines[i]).trim();
    if (!line) continue;
    return line.length > LAST_LINE_MAX ? `${line.slice(0, LAST_LINE_MAX - 1)}…` : line;
  }
  return '';
}
