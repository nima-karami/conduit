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
const DCS = 0x50; // 'P'
const SOS = 0x58; // 'X'
const PM = 0x5e; // '^'
const APC = 0x5f; // '_'

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

/**
 * Where a bell scan stopped, so the next chunk can resume mid-sequence. `text` is the
 * only state in which a BEL is a bell.
 */
export type BellScanState =
  | 'text'
  | 'esc' // saw ESC, awaiting the byte that says what kind of sequence this is
  | 'esc-int' // ESC with intermediate bytes, e.g. `ESC ( B`
  | 'csi' // inside `ESC [`, awaiting the final byte
  | 'osc' // inside `ESC ]` — BEL or ST closes it
  | 'osc-esc' // inside an OSC, saw ESC (ST if a backslash follows)
  | 'str' // inside DCS/APC/PM/SOS — only ST closes these
  | 'str-esc';

export interface BellScan {
  bells: number;
  state: BellScanState;
}

/**
 * Count the BELs in a chunk that are real bells — i.e. not the terminator of an escape
 * string, and not a payload byte inside one. A bare BEL is the terminal ecosystem's
 * explicit "I want the user" signal (Claude Code rings it on a permission prompt), so it
 * arms attention with no quiet wait; see docs/specs/2026-08-21-attention-signal-quality.md
 * contract 2, which also names `includes('\x07')` as the failure mode — every OSC title
 * update a TUI emits ends in one.
 *
 * Resumable, and the caller MUST thread `state` through per session: PTY chunks are
 * whatever `proc.onData` hands over, so `ESC ]0;tit` / `le BEL` is an ordinary way for a
 * title to arrive. Scanning each chunk cold invents a bell from the second half, and
 * swallows a real bell that lands after a title the previous chunk left open.
 *
 * A sibling walker to {@link stripAnsi} rather than an extension of it: the two disagree
 * on purpose about DCS/APC/PM/SOS. stripAnsi renders text and leaves those payloads alone
 * (they never reach a card subtitle in practice); here a 0x07 inside a sixel or DECRQSS
 * payload must not ring, so the string states are walked to their ST.
 */
export function countBareBells(chunk: string, from: BellScanState = 'text'): BellScan {
  let bells = 0;
  let state = from;
  let i = 0;
  while (i < chunk.length) {
    const c = chunk.charCodeAt(i);
    switch (state) {
      case 'text':
        if (c === BEL) bells += 1;
        else if (c === ESC) state = 'esc';
        i += 1;
        break;
      case 'esc':
        if (c === CSI) state = 'csi';
        else if (c === OSC) state = 'osc';
        else if (c === DCS || c === SOS || c === PM || c === APC) state = 'str';
        else if (c >= 0x20 && c <= 0x2f) state = 'esc-int';
        else if (c !== ESC) state = 'text'; // two-character escape, consumed
        i += 1;
        break;
      case 'esc-int':
        if (c < 0x20 || c > 0x2f) state = 'text'; // the final byte
        i += 1;
        break;
      case 'csi':
        // Parameter/intermediate bytes; the first byte outside that range is the final.
        if (c < 0x20 || c > 0x3f) state = 'text';
        i += 1;
        break;
      case 'osc':
        if (c === BEL)
          state = 'text'; // a terminator, not a bell
        else if (c === ESC) state = 'osc-esc';
        i += 1;
        break;
      case 'osc-esc':
        // Not ST: that ESC was payload, so re-read this byte as OSC content.
        if (c === BACKSLASH) {
          state = 'text';
          i += 1;
        } else {
          state = 'osc';
        }
        break;
      case 'str':
        if (c === ESC) state = 'str-esc';
        i += 1; // a BEL here is payload, never a bell
        break;
      case 'str-esc':
        if (c === BACKSLASH) {
          state = 'text';
          i += 1;
        } else {
          state = 'str';
        }
        break;
    }
  }
  return { bells, state };
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
