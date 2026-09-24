// Facts about raw PTY output that don't depend on what the program means by it. Pure; escape
// sequences are hand-scanned for the same reason as src/last-line.ts `stripAnsi`.
import { stripAnsi } from './last-line';

const BEL = 0x07;
const CSI = 0x5b; // '['
const OSC = 0x5d; // ']'
const QUESTION = 0x3f; // '?'
const isParam = (c: number) => c >= 0x30 && c <= 0x3f;
const isIntermediate = (c: number) => c >= 0x20 && c <= 0x2f;
const isFinal = (c: number) => c >= 0x40 && c <= 0x7e;
// A tail longer than this is not a sequence a terminal would still be completing.
const MAX_TAIL = 256;

/**
 * A chunk that draws nothing: only escape sequences, whitespace and non-bell controls. A TUI
 * answering a focus change (claude re-asserting `?2004h`, erasing a line) sends these; they are
 * not the program working (mf-live-edits QA F1). A bare BEL is not inert — it is attention
 * evidence.
 */
export function isInertOutput(chunk: string): boolean {
  const text = stripAnsi(chunk);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BEL || (c > 0x20 && c !== 0x7f)) return false;
  }
  return true;
}

/** Split off a trailing escape sequence the chunk ends in the middle of, to prepend to the next. */
export function splitIncompleteEscape(s: string): [string, string] {
  const i = s.lastIndexOf('\x1b');
  if (i < 0) return [s, ''];
  const incomplete = (): [string, string] => [s.slice(0, i), s.slice(i)];
  let j = i + 1;
  if (j >= s.length) return incomplete();
  const kind = s.charCodeAt(j);
  if (kind === CSI || isIntermediate(kind)) {
    j += 1;
    if (kind === CSI) while (j < s.length && isParam(s.charCodeAt(j))) j += 1;
    while (j < s.length && isIntermediate(s.charCodeAt(j))) j += 1;
    return j < s.length && isFinal(s.charCodeAt(j)) ? [s, ''] : incomplete();
  }
  if (kind === OSC) return s.indexOf('\x07', j) >= 0 ? [s, ''] : incomplete();
  // Two-character escapes, including the ST (`ESC \`) that ends an OSC.
  return [s, ''];
}

export interface PasteModeState {
  /** Bracketed paste mode (`?2004`) as the child last set it. */
  on: boolean;
  tail: string;
}

export const PASTE_MODE_OFF: PasteModeState = { on: false, tail: '' };

/** Follow the child's `ESC[?2004h` / `ESC[?2004l` across chunks. */
export function trackBracketedPaste(prev: PasteModeState, chunk: string): PasteModeState {
  const [done, rawTail] = splitIncompleteEscape(prev.tail + chunk);
  let on = prev.on;
  for (let i = done.indexOf('\x1b'); i >= 0; i = done.indexOf('\x1b', i + 1)) {
    if (done.charCodeAt(i + 1) !== CSI || done.charCodeAt(i + 2) !== QUESTION) continue;
    let j = i + 3;
    while (j < done.length && isParam(done.charCodeAt(j))) j += 1;
    const final = done[j];
    if (final !== 'h' && final !== 'l') continue;
    if (
      done
        .slice(i + 3, j)
        .split(';')
        .includes('2004')
    )
      on = final === 'h';
  }
  return { on, tail: rawTail.length > MAX_TAIL ? '' : rawTail };
}
