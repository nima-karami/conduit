// Claude's own answer to an `/add-dir`, read off its PTY output — the only evidence that makes a
// folder seen (mf-live-edits spec §2.3). Pure and renderer-safe.
import { folderKey } from './folder-key';
import { stripAnsi } from './last-line';
import { splitIncompleteEscape } from './terminal-output';

export type AddDirOutcome = 'added' | 'declined';

/**
 * Claude Code 2.1.282's lines, measured. Each is a tool result, so it follows claude's result
 * marker (U+23BF): the anchor that keeps the model's own prose, and a longer path ending in
 * this one, from counting (review S1). `{p}` is the folder. If claude rewords these, nothing
 * matches and the banner stays (spec §2.3).
 */
const LINES: ReadonlyArray<readonly [string, AddDirOutcome]> = [
  ['Added {p} as a working directory', 'added'],
  ['{p} is already added as a working directory', 'added'],
  ['{p} is inside the current working directory', 'added'],
  ['Did not add {p} as a working directory', 'declined'],
  ['Path {p} was not found', 'declined'],
];
const RESULT_MARK = '\u23BF';

/** Longer than any line above with a 260-character path in it. */
const TEXT_CARRY = 1024;

export interface AddDirScanState {
  /** Laid-out text (see `layout`) not yet consumed by a match. */
  text: string;
  /** An escape sequence the last chunk ended inside. */
  raw: string;
}

export const ADD_DIR_SCAN_START: AddDirScanState = { text: '', raw: '' };

export interface AddDirMatch {
  path: string;
  outcome: AddDirOutcome;
}

/**
 * The text as it reads on screen, whitespace kept but collapsed: a run is `\n` if it crosses a
 * row (a line break or a cursor jump), one space otherwise. Kept rather than stripped so `a b`
 * and `ab` stay two folders (review N3). claude draws some spaces as `ESC[1C`.
 */
function layout(s: string): string {
  const moved = s
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching cursor-motion CSI sequences
    .replace(/\x1b\[[\d;]*([ABCEFHdf])/g, (_, f: string) => (f === 'C' ? ' ' : '\n'))
    .replace(/[\r\n\v\f]/g, '\n');
  let out = '';
  for (const ch of stripAnsi(moved)) {
    const c = ch.charCodeAt(0);
    out += ch === '\n' ? '\n' : c <= 0x20 || c === 0x7f ? ' ' : ch;
  }
  return collapse(out);
}

function collapse(s: string): string {
  return s.replace(/[ \n]{2,}/g, (run) => (run.includes('\n') ? '\n' : ' '));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const GAP = '[ \\n]';

/**
 * claude's words. A row that fills to the last column comes back from ConPTY with the wrap
 * cell repeated after the break (`workin⏎ng`, QA N1), so any one of its letters may be.
 */
function wordsPattern(words: string): string {
  let out = '';
  for (const ch of words) out += ch === ' ' ? GAP : `${esc(ch)}(?:\\n${esc(ch)})?`;
  return out;
}

/** The folder, exactly: claude wraps a path only at a space, and a repeat here is not tolerated. */
function pathPattern(key: string): string {
  let out = '';
  for (const ch of key) out += ch === ' ' ? GAP : esc(ch);
  return out;
}

/** The forms claude may print a folder in: separators folded, drive letters case-folded. */
function pathForm(p: string): { key: string; fold: boolean } {
  const key = folderKey(p).replace(/\\/g, '/').replace(/\s+/g, ' ');
  return { key, fold: /^[a-z]:(\/|$)/.test(key) };
}

/**
 * Feed one PTY chunk. Reports, per path, the LAST outcome claude printed for it in this chunk
 * (plus the carried tail); the text up to the end of the last match is consumed, so a match is
 * reported once — a later full repaint that reprints the line reports it again, which callers
 * must treat as idempotent.
 */
export function scanAddDirOutput(
  prev: AddDirScanState,
  chunk: string,
  paths: readonly string[],
): { state: AddDirScanState; matches: AddDirMatch[] } {
  const [done, raw] = splitIncompleteEscape(prev.raw + chunk);
  const text = collapse(prev.text + layout(done)).replace(/\\/g, '/');
  const matches: AddDirMatch[] = [];
  let consumed = 0;
  for (const path of paths) {
    const { key, fold } = pathForm(path);
    if (key === '') continue;
    let best: { at: number; end: number; outcome: AddDirOutcome } | undefined;
    for (const [line, outcome] of LINES) {
      const [before, after] = line.split('{p}');
      // A drive root is printed `C:\`; its key may have no trailing separator.
      const re = new RegExp(
        `${RESULT_MARK}${GAP}?${wordsPattern(before)}(${pathPattern(key)})/?${wordsPattern(after)}`,
        'giu',
      );
      for (let m = re.exec(text); m; m = re.exec(text)) {
        // claude's words are matched case-blind; a posix path's own case still has to agree.
        if (!fold && m[1].replace(/\n/g, ' ') !== key) continue;
        if (!best || m.index > best.at) best = { at: m.index, end: m.index + m[0].length, outcome };
      }
    }
    if (best) {
      matches.push({ path, outcome: best.outcome });
      consumed = Math.max(consumed, best.end);
    }
  }
  const rest = text.slice(consumed);
  return {
    state: { text: rest.length > TEXT_CARRY ? rest.slice(-TEXT_CARRY) : rest, raw },
    matches,
  };
}
