import { useEffect, useMemo, useState } from 'react';
import { langFromPath } from '../../src/lang';
import type { ChangeDTO, FileDiffDTO } from '../../src/protocol';
import {
  computeFileReview,
  type FileReview,
  type ReviewHunk,
  type ReviewLine,
} from '../../src/review-hunks';
import { joinPath } from '../file-tree';
import { IconChevron, IconClose, IconExternal, IconReview } from '../icons';
import { useEscapeKey } from '../use-escape-key';
import { EmptyState } from './empty-state';

/**
 * R3 — Review mode. A single, scrollable view that stacks ALL working-tree changes
 * across files as hunk-level diff cards. Each file shows only its changed regions plus
 * a few context lines; unchanged runs between hunks collapse into expandable fold rows.
 *
 * Rendering is intentionally lightweight: plain styled rows (NOT N Monaco editors,
 * which would be far too heavy for a whole-tree review). Hunk/fold extraction is the
 * pure, unit-tested `computeFileReview` (src/review-hunks.ts). Read-only v1 — no inline
 * comments / staging / accept-reject from here (deferred).
 */
export function ReviewView({
  projectPath,
  changes,
  diffs,
  onRequestDiff,
  onJumpToHunk,
  onClose,
}: {
  projectPath: string | undefined;
  /** Working-tree changes (the Changes panel's list). One review card per file. */
  changes: ChangeDTO[];
  /** Diff content keyed by ABSOLUTE path (head/work), filled in as the host replies. */
  diffs: Map<string, FileDiffDTO>;
  /** Ask the host for a file's diff (absolute path). Called once per changed file. */
  onRequestDiff: (absPath: string) => void;
  /** Open the file in the editor revealed at a hunk's WORK line. */
  onJumpToHunk: (absPath: string, line: number) => void;
  onClose: () => void;
}) {
  useEscapeKey(onClose);

  // A change can appear twice (staged + unstaged side); review each PATH once.
  const files = useMemo(() => {
    const seen = new Set<string>();
    const out: ChangeDTO[] = [];
    for (const c of changes) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push(c);
    }
    return out;
  }, [changes]);

  const absOf = (rel: string) => (projectPath ? joinPath(projectPath, rel) : rel);

  // Absolute paths for every reviewed file — stable string list drives the fetch effect.
  const absPaths = useMemo(
    () => files.map((c) => (projectPath ? joinPath(projectPath, c.path) : c.path)),
    [files, projectPath],
  );

  // Request every changed file's diff once on mount / when the file set changes. The
  // host streams them back into `diffs`; cards render skeletons until their diff lands.
  useEffect(() => {
    for (const abs of absPaths) onRequestDiff(abs);
  }, [absPaths, onRequestDiff]);

  return (
    <div className="review">
      <div className="review__head">
        <span className="review__title">Review changes</span>
        <span className="review__sub">
          {files.length === 0
            ? 'No changes to review'
            : `${files.length} file${files.length === 1 ? '' : 's'} changed`}
        </span>
        <button
          type="button"
          className="iconbtn review__close"
          title="Close review (Esc)"
          aria-label="Close review"
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="review__scroll">
        {files.length === 0 ? (
          <EmptyState
            variant="pane"
            icon={<IconReview size={28} />}
            title="Nothing to review"
            hint="The working tree is clean — make some changes and they'll show up here."
          />
        ) : (
          files.map((c) => (
            <ReviewFileCard
              key={c.path}
              change={c}
              abs={absOf(c.path)}
              diff={diffs.get(absOf(c.path))}
              onJumpToHunk={onJumpToHunk}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ReviewFileCard({
  change,
  abs,
  diff,
  onJumpToHunk,
}: {
  change: ChangeDTO;
  abs: string;
  diff: FileDiffDTO | undefined;
  onJumpToHunk: (absPath: string, line: number) => void;
}) {
  const review: FileReview | null = useMemo(() => {
    if (!diff || diff.binary) return null;
    return computeFileReview(diff.head, diff.work);
  }, [diff]);

  const parts = change.path.split('/');
  const file = parts.pop() ?? change.path;
  const dir = parts.join('/');
  const language = langFromPath(change.path);

  return (
    <section className="rcard" aria-label={`Changes in ${change.path}`}>
      <header className="rcard__head">
        <span className={`change__kind change__kind--${change.kind}`}>{change.kind}</span>
        <span className="rcard__path">
          {dir && <span className="rcard__dir">{dir}/</span>}
          <span className="rcard__file">{file}</span>
        </span>
        <span className="rcard__stat">
          {change.added > 0 && <span className="diffstat--add">+{change.added}</span>}
          {change.removed > 0 && <span className="diffstat--del"> -{change.removed}</span>}
        </span>
        <button
          type="button"
          className="rcard__open"
          title="Open this file in the editor"
          onClick={() => onJumpToHunk(abs, review?.hunks[0]?.startNewLine ?? 1)}
        >
          <IconExternal size={13} /> Open file
        </button>
      </header>

      {diff?.binary ? (
        <div className="rcard__notice">Binary file — no diff preview.</div>
      ) : !review ? (
        <div className="rcard__notice rcard__notice--loading">Loading diff…</div>
      ) : review.hunks.length === 0 ? (
        <div className="rcard__notice">No textual changes.</div>
      ) : (
        <HunkList review={review} abs={abs} language={language} onJumpToHunk={onJumpToHunk} />
      )}
    </section>
  );
}

function HunkList({
  review,
  abs,
  language,
  onJumpToHunk,
}: {
  review: FileReview;
  abs: string;
  language: string;
  onJumpToHunk: (absPath: string, line: number) => void;
}) {
  // Interleave fold rows (keyed by the hunk index they precede) with hunks. A fold
  // with index `i` sits immediately before hunk `i`; index === hunks.length sits after
  // the last hunk.
  const foldsByIndex = useMemo(() => {
    const m = new Map<number, FileReview['folds'][number]>();
    for (const f of review.folds) m.set(f.index, f);
    return m;
  }, [review]);

  const rows: JSX.Element[] = [];
  for (let i = 0; i <= review.hunks.length; i++) {
    const fold = foldsByIndex.get(i);
    if (fold) {
      rows.push(<FoldRow key={`fold-${i}`} fold={fold} language={language} />);
    }
    const hunk = review.hunks[i];
    if (hunk) {
      rows.push(<Hunk key={`hunk-${i}`} hunk={hunk} abs={abs} onJumpToHunk={onJumpToHunk} />);
    }
  }
  return <div className="rhunks">{rows}</div>;
}

function FoldRow({ fold, language }: { fold: FileReview['folds'][number]; language: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rfold">
      <button
        type="button"
        className="rfold__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Collapse unchanged lines' : 'Expand unchanged lines'}
      >
        <IconChevron size={12} className={open ? 'rfold__chev rfold__chev--open' : 'rfold__chev'} />
        {open ? 'Hide' : 'Show'} {fold.count} unchanged line{fold.count === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="rfold__lines">
          {/* The hidden lines aren't carried in the fold (only a count) — expanding
              shows a placeholder run so the user knows what was collapsed. A future
              iteration can stream the real text; for v1 the count + jump-to-file is the
              contract. */}
          <pre className={`rline rline--context lang-${language}`} aria-hidden="true">
            <span className="rline__gutter" />
            <span className="rline__text rline__text--muted">
              … {fold.count} unchanged line{fold.count === 1 ? '' : 's'} (open the file to view) …
            </span>
          </pre>
        </div>
      )}
    </div>
  );
}

function Hunk({
  hunk,
  abs,
  onJumpToHunk,
}: {
  hunk: ReviewHunk;
  abs: string;
  onJumpToHunk: (absPath: string, line: number) => void;
}) {
  return (
    <div className="rhunk">
      <button
        type="button"
        className="rhunk__jump"
        title="Open this hunk in the editor"
        onClick={() => onJumpToHunk(abs, hunk.startNewLine)}
      >
        @ line {hunk.startNewLine}
      </button>
      <div className="rhunk__lines">
        {hunk.lines.map((l) => (
          <Line key={l.seq} line={l} />
        ))}
      </div>
    </div>
  );
}

const SIGN: Record<ReviewLine['kind'], string> = { context: ' ', add: '+', del: '-' };

function Line({ line }: { line: ReviewLine }) {
  const gutter =
    line.kind === 'add'
      ? `+${line.newLine ?? ''}`
      : line.kind === 'del'
        ? `-${line.oldLine ?? ''}`
        : `${line.newLine ?? ''}`;
  return (
    <pre className={`rline rline--${line.kind}`}>
      <span className="rline__gutter">{gutter}</span>
      <span className="rline__sign">{SIGN[line.kind]}</span>
      <span className="rline__text">{line.text === '' ? ' ' : line.text}</span>
    </pre>
  );
}
