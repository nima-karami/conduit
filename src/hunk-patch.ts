import type { ReviewHunk } from './review-hunks';

/**
 * Unified-diff surgery for hunk-level stage / unstage / discard
 * (spec 2026-08-27-review-supercharge §2 Lane E).
 *
 * BYTE-FAITHFUL BY CONSTRUCTION. The input is git's own `git diff` stdout and the output is fed
 * straight back to `git apply`, so `\r` is CONTENT: the only separator this module knows is
 * `\n`, nothing is trimmed, and `\ No newline at end of file` rides along inside its hunk. That
 * is the whole reason patches are built here from git's bytes rather than re-rendered from the
 * renderer's LF-normalised text (§0 "a renderer-built patch can never be byte-correct").
 *
 * Node-free: the renderer imports HunkRange and hunkRange; the host imports selectHunks.
 */

/**
 * A line range on both sides of a diff, 1-based inclusive. `end < start` marks an EMPTY span,
 * with `start` naming the position it sits at — a pure deletion has no new-side lines, a pure
 * insertion no old-side ones, and a tuple has no other way to say so.
 */
export interface HunkRange {
  new: [number, number];
  old: [number, number];
}

export interface DiffHunk {
  /** The `@@ …` line verbatim, section heading included. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Header + body, each line followed by `\n`. Concatenating these after `ParsedDiff.header`
   *  reproduces the input exactly. */
  text: string;
  /** Span of the `+` lines. Empty for a pure deletion. */
  changedNew: [number, number];
  /** Span of the `-` lines. Empty for a pure insertion. */
  changedOld: [number, number];
}

export interface ParsedDiff {
  /** Everything before the first `@@`: `diff --git`, mode/index/rename lines, `---`, `+++`. */
  header: string;
  hunks: DiffHunk[];
  /** git refused to diff the contents; nothing here is selectable. */
  binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const emptyAt = (n: number): [number, number] => [n, n - 1];

const extend = (span: [number, number], line: number): [number, number] =>
  span[1] < span[0] ? [line, line] : [Math.min(span[0], line), Math.max(span[1], line)];

/** Lines of `text`, with the artefact of a trailing `\n` dropped. `\r` is left on every line. */
function rawLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = rawLines(text);
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let binary = false;
  let i = 0;

  for (; i < lines.length && !HUNK_HEADER.test(lines[i]); i++) {
    const l = lines[i];
    if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) binary = true;
    headerLines.push(l);
  }

  while (i < lines.length) {
    const m = HUNK_HEADER.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const header = lines[i];
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    i++;

    const body: string[] = [];
    for (; i < lines.length && !HUNK_HEADER.test(lines[i]); i++) body.push(lines[i]);

    let oldLine = oldStart;
    let newLine = newStart;
    let changedOld = emptyAt(oldStart);
    let changedNew = emptyAt(newStart);
    // Where an EMPTY span sits, captured at the seam: while the loop is standing on the first
    // `+`, `oldLine` is already "the old line this insertion comes before", and symmetrically
    // for `newLine` on the first `-`. Anchoring at the hunk's start instead would point a
    // caller at the leading context rather than at the change.
    let insertAnchorOld: number | null = null;
    let deleteAnchorNew: number | null = null;
    for (const l of body) {
      // "\ No newline at end of file" annotates the PREVIOUS line; it is not content.
      if (l.startsWith('\\')) continue;
      const c = l.charAt(0);
      if (c === '+') {
        if (insertAnchorOld === null) insertAnchorOld = oldLine;
        changedNew = extend(changedNew, newLine);
        newLine++;
      } else if (c === '-') {
        if (deleteAnchorNew === null) deleteAnchorNew = newLine;
        changedOld = extend(changedOld, oldLine);
        oldLine++;
      } else {
        oldLine++;
        newLine++;
      }
    }
    if (changedOld[1] < changedOld[0] && insertAnchorOld !== null) {
      changedOld = emptyAt(insertAnchorOld);
    }
    if (changedNew[1] < changedNew[0] && deleteAnchorNew !== null) {
      changedNew = emptyAt(deleteAnchorNew);
    }

    hunks.push({
      header,
      oldStart,
      oldCount,
      newStart,
      newCount,
      text: [header, ...body].map((l) => `${l}\n`).join(''),
      changedNew,
      changedOld,
    });
  }

  return {
    header: headerLines.map((l) => `${l}\n`).join(''),
    hunks,
    binary,
  };
}

/** True when both spans are non-empty and share at least one line. */
export function spansOverlap(a: [number, number], b: [number, number]): boolean {
  if (a[1] < a[0] || b[1] < b[0]) return false;
  return a[0] <= b[1] && a[1] >= b[0];
}

/**
 * Match on the CHANGED lines, never the `@@` header span: the header covers up to 3 context
 * lines a side, so header matching would select a hunk a range merely brushes past. Either side
 * may carry the match — a pure-deletion hunk has no new-side lines at all, and a pure insertion
 * no old-side ones (see the Lane E plan, assumptions 4 and 5).
 */
export function selectsHunk(hunk: DiffHunk, range: HunkRange): boolean {
  return spansOverlap(hunk.changedNew, range.new) || spansOverlap(hunk.changedOld, range.old);
}

/**
 * The sub-patch of `diffText` covering `range`: the original file header verbatim plus every
 * hunk the range touches, in file order. Empty string when nothing matches (including a binary
 * diff) — the caller reports that as `no-hunk` rather than running an empty apply.
 */
export function selectHunks(diffText: string, range: HunkRange): string {
  const parsed = parseUnifiedDiff(diffText);
  if (parsed.binary) return '';
  const picked = parsed.hunks.filter((h) => selectsHunk(h, range));
  if (picked.length === 0) return '';
  return `${parsed.header}${picked.map((h) => h.text).join('')}`;
}

/** The line range one Review hunk covers. A hunk can hold several change runs separated by a
 *  short unchanged gap (computeFileReview keeps gaps of up to 2*context inside one hunk), and
 *  the header's Stage button acts on the hunk the user sees — so the span covers them all. */
export function hunkRange(hunk: ReviewHunk): HunkRange {
  let changedNew: [number, number] = emptyAt(hunk.startNewLine);
  let changedOld: [number, number] = emptyAt(hunk.startOldLine ?? 1);
  let lastOld = (hunk.startOldLine ?? 1) - 1;
  let lastNew = hunk.startNewLine - 1;
  // The seam an empty span sits at: the line AFTER the last one on that side before the first
  // change, so a caller points at where the insertion (or deletion) went rather than at the
  // hunk's leading context.
  let insertAnchorOld: number | null = null;
  let deleteAnchorNew: number | null = null;

  for (const l of hunk.lines) {
    if (l.kind === 'add' && l.newLine !== null) {
      if (insertAnchorOld === null) insertAnchorOld = lastOld + 1;
      changedNew = extend(changedNew, l.newLine);
    } else if (l.kind === 'del' && l.oldLine !== null) {
      if (deleteAnchorNew === null) deleteAnchorNew = lastNew + 1;
      changedOld = extend(changedOld, l.oldLine);
    }
    if (l.oldLine !== null) lastOld = l.oldLine;
    if (l.newLine !== null) lastNew = l.newLine;
  }

  const sawAdd = changedNew[1] >= changedNew[0];
  const sawDel = changedOld[1] >= changedOld[0];
  return {
    new: sawAdd ? changedNew : emptyAt(deleteAnchorNew ?? hunk.startNewLine),
    old: sawDel ? changedOld : emptyAt(insertAnchorOld ?? hunk.startOldLine ?? 1),
  };
}
