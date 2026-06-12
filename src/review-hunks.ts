// Pure hunk extraction for the Review view (R3). Given the HEAD (original) and
// working-tree (modified) text of a single file, produce a list of *hunks* — the
// changed regions plus a few unchanged context lines on each side — with *fold*
// markers describing the unchanged runs collapsed between consecutive hunks.
//
// DIFF ALGORITHM CHOICE — a self-contained line-level LCS (Hunt–Szymanski-style
// dynamic LCS) lives here rather than reusing Monaco's `computeDiff`. Monaco's
// line-change computation only runs inside an editor/worker backed by the DOM, so
// it is not cleanly callable headlessly and cannot be unit-tested in Node without a
// browser. The Review view also must NOT instantiate Monaco editors per file (too
// heavy — see the spec), so there is no editor to borrow `getLineChanges()` from.
// A small line-LCS is O(N*M) in the worst case but N,M here are line counts of a
// single file's two versions — fine for interactive use, and it is trivially pure
// and exhaustively testable. The output models added / removed / context lines the
// same way Monaco would (contiguous changed regions), which is all the Review UI
// needs.

export type ReviewLineKind = 'context' | 'add' | 'del';

export interface ReviewLine {
  kind: ReviewLineKind;
  /** Text of the line (without trailing newline). */
  text: string;
  /** 1-based line number in the HEAD (original) file, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the WORK (modified) file, or null for a removed line. */
  newLine: number | null;
  /** Stable per-file sequence index (the line's position in the full edit list). Unique
   *  and never reordered — a stable React key for the row, so the renderer needs no
   *  array-index keys. */
  seq: number;
}

/** A run of unchanged lines hidden between two hunks (or before/after all hunks). */
export interface Fold {
  /** How many unchanged lines this fold hides (== `lines.length`). */
  count: number;
  /** 1-based WORK line number the hidden run starts at (for jump targets). */
  startNewLine: number;
  /** The actual hidden context lines, so the UI can reveal them on demand (expand
   *  up/down) instead of showing a placeholder. All `kind: 'context'`. */
  lines: ReviewLine[];
}

export interface ReviewHunk {
  /** 1-based WORK line number of this hunk's first rendered line (its jump target). */
  startNewLine: number;
  /** 1-based HEAD line number of this hunk's first rendered line (may be null if pure-add). */
  startOldLine: number | null;
  lines: ReviewLine[];
}

export interface FileReview {
  /** Hunks in file order. Empty when the two sides are identical. */
  hunks: ReviewHunk[];
  /** Folds in file order, interleaved with hunks: there is one fold *before* the
   *  first hunk (if leading context was collapsed), one *between* each pair, and one
   *  *after* the last. `index` is the count of hunks preceding the fold (0..hunks.length),
   *  so the renderer can place a fold row at exactly the right seam. */
  folds: (Fold & { index: number })[];
  added: number;
  removed: number;
}

interface Op {
  kind: ReviewLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Split text into lines, dropping a single trailing newline so a file ending in
 *  "\n" doesn't yield a spurious empty final line. */
function splitLines(s: string): string[] {
  if (s === '') return [];
  const normalized = s.endsWith('\n') ? s.slice(0, -1) : s;
  return normalized.split('\n');
}

/** Line-level LCS length table, then backtrack to a sequence of edit ops. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]. Build bottom-up.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'context', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i], oldLine: i + 1, newLine: null });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j], oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i], oldLine: i + 1, newLine: null });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j], oldLine: null, newLine: j + 1 });
    j++;
  }
  return ops;
}

/**
 * Compute the Review hunks + folds for one file. `context` is the number of
 * unchanged lines kept on each side of a changed region (default 3, like `git diff`).
 * Unchanged runs longer than `2*context` are split: `context` lines hang onto the
 * preceding hunk, `context` onto the following one, and the middle becomes a fold.
 * Runs of `2*context` or fewer stay inline (no fold) so tiny gaps aren't collapsed.
 */
export function computeFileReview(head: string, work: string, context = 3): FileReview {
  const a = splitLines(head);
  const b = splitLines(work);
  const ops = diffLines(a, b);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added++;
    else if (op.kind === 'del') removed++;
  }

  const hunks: ReviewHunk[] = [];
  const folds: (Fold & { index: number })[] = [];
  if (added === 0 && removed === 0) {
    return { hunks, folds, added, removed };
  }

  // Walk ops, grouping changed lines together with up-to-`context` neighbouring
  // context lines. A long context gap between two changes ends the current hunk and
  // emits a fold; a short gap keeps the hunk open (its lines render inline).
  let current: ReviewLine[] = [];
  let pendingContext: ReviewLine[] = []; // unchanged lines seen since the last change

  const toLine = (op: Op, seq: number): ReviewLine => ({
    kind: op.kind,
    text: op.text,
    oldLine: op.oldLine,
    newLine: op.newLine,
    seq,
  });

  const flushHunk = () => {
    if (current.length === 0) return;
    const first = current[0];
    hunks.push({
      startNewLine: firstNewLine(current),
      startOldLine: first.oldLine,
      lines: current,
    });
    current = [];
  };

  const recordFold = (hidden: ReviewLine[], startNew: number) => {
    folds.push({
      count: hidden.length,
      startNewLine: startNew,
      lines: hidden,
      index: hunks.length,
    });
  };

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind === 'context') {
      // Buffer unchanged lines; resolved into leading/inline/trailing context (or a
      // fold) when the next change arrives or the file ends.
      pendingContext.push(toLine(op, k));
      continue;
    }

    // op is a change. Resolve the pendingContext that sits before it.
    if (pendingContext.length > 0) {
      if (current.length === 0) {
        // Context before the FIRST change of a brand-new hunk. Keep only the last
        // `context` lines as leading context; everything earlier is a fold.
        const lead = pendingContext.slice(Math.max(0, pendingContext.length - context));
        const hiddenCount = pendingContext.length - lead.length;
        if (hiddenCount > 0) {
          const hidden = pendingContext.slice(0, hiddenCount);
          recordFold(hidden, hidden[0].newLine ?? firstNewLine(hidden));
        }
        current.push(...lead);
      } else {
        // Context BETWEEN changes within a hunk. If short enough, keep inline; if too
        // long, close the hunk (with trailing context) and open a fold.
        if (pendingContext.length <= context * 2) {
          current.push(...pendingContext);
        } else {
          const trail = pendingContext.slice(0, context);
          const lead = pendingContext.slice(pendingContext.length - context);
          const hidden = pendingContext.slice(context, pendingContext.length - context);
          current.push(...trail);
          flushHunk();
          recordFold(hidden, hidden[0].newLine ?? firstNewLine(hidden));
          current.push(...lead);
        }
      }
      pendingContext = [];
    }
    current.push(toLine(op, k));
  }

  // Trailing context after the last change: keep up to `context`, fold the rest.
  if (pendingContext.length > 0 && current.length > 0) {
    const trail = pendingContext.slice(0, context);
    current.push(...trail);
    const hiddenCount = pendingContext.length - trail.length;
    flushHunk();
    if (hiddenCount > 0) {
      const hidden = pendingContext.slice(trail.length);
      recordFold(hidden, hidden[0].newLine ?? firstNewLine(hidden));
    }
  } else {
    flushHunk();
  }

  return { hunks, folds, added, removed };
}

/** First WORK line number appearing in a run of lines (added lines have a newLine;
 *  pure-removed lines fall back to their following line's number via the next entry). */
function firstNewLine(lines: ReviewLine[]): number {
  for (const l of lines) {
    if (l.newLine !== null) return l.newLine;
  }
  // All-removed region: anchor to 1 (jump lands at file top). Rare edge.
  return 1;
}
