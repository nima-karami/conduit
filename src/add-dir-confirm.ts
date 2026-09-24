// Claude's own answer to an `/add-dir`, read off its PTY output — the only evidence that makes a
// folder seen (mf-live-edits spec §2.3). Pure and renderer-safe.
import { folderKey } from './folder-key';
import { stripAnsi } from './last-line';
import { splitIncompleteEscape } from './terminal-output';

export type AddDirOutcome = 'added' | 'declined';

/**
 * Claude Code 2.1.282's lines, measured, with all whitespace removed: it wraps a long path at
 * any space and indents the continuation, so only a whitespace-free comparison survives. `{p}`
 * is the folder. If claude rewords these, nothing matches and the banner stays (spec §2.3).
 */
const LINES: ReadonlyArray<readonly [string, AddDirOutcome]> = [
  ['added{p}asaworkingdirectory', 'added'],
  ['{p}isalreadyaddedasaworkingdirectory', 'added'],
  ['{p}isinsidethecurrentworkingdirectory', 'added'],
  ['didnotadd{p}asaworkingdirectory', 'declined'],
  ['path{p}wasnotfound', 'declined'],
];

/** Longer than any line above with a 260-character path in it. */
const TEXT_CARRY = 1024;

export interface AddDirScanState {
  /** Whitespace-free text not yet consumed by a match. */
  text: string;
  /** An escape sequence the last chunk ended inside. */
  raw: string;
}

export const ADD_DIR_SCAN_START: AddDirScanState = { text: '', raw: '' };

export interface AddDirMatch {
  path: string;
  outcome: AddDirOutcome;
}

function compact(s: string): string {
  let out = '';
  for (const ch of stripAnsi(s)) if (ch.charCodeAt(0) > 0x20 && ch !== '\x7f') out += ch;
  return out;
}

/** The forms claude may print a folder in: separators folded, drive letters case-folded. */
function pathForm(p: string): { key: string; fold: boolean } {
  const key = compact(folderKey(p));
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
  const text = (prev.text + compact(done)).replace(/\\/g, '/');
  // claude's words are matched case-blind; a posix path's own case still has to agree.
  const folded = text.toLowerCase();
  const matches: AddDirMatch[] = [];
  let consumed = 0;
  for (const path of paths) {
    const { key, fold } = pathForm(path);
    if (key === '') continue;
    let best: { at: number; end: number; outcome: AddDirOutcome } | undefined;
    for (const [line, outcome] of LINES) {
      const [before, after] = line.split('{p}');
      // A drive root is printed `C:\`; its key has no trailing separator.
      for (const k of [key, `${key}/`]) {
        const needle = `${before}${k.toLowerCase()}${after}`;
        for (
          let at = folded.lastIndexOf(needle);
          at >= 0;
          at = at > 0 ? folded.lastIndexOf(needle, at - 1) : -1
        ) {
          if (!fold && text.slice(at + before.length, at + before.length + k.length) !== k)
            continue;
          if (!best || at > best.at) best = { at, end: at + needle.length, outcome };
          break;
        }
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
