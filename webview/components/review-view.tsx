import { useEffect, useMemo, useState } from 'react';
import type { ChangeDTO, FileDiffDTO } from '../../src/protocol';
import {
  computeFileReview,
  type FileReview,
  type ReviewHunk,
  type ReviewLine,
} from '../../src/review-hunks';
import { joinPath } from '../file-tree';
import { IconChevron, IconExternal, IconReview } from '../icons';
import { useEscapeKey } from '../use-escape-key';
import { EmptyState } from './empty-state';

/**
 * R3 — Review mode. One scrollable view stacking ALL working-tree changes as hunk-level
 * diff cards, unchanged runs collapsed into expandable folds. Rendered as plain styled
 * rows (NOT N Monaco editors — too heavy for a whole-tree review); hunk/fold extraction
 * is the pure `computeFileReview`. Read-only v1.
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

  // Host streams diffs back into `diffs`; cards render skeletons until theirs lands.
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
        <HunkList review={review} abs={abs} onJumpToHunk={onJumpToHunk} />
      )}
    </section>
  );
}

function HunkList({
  review,
  abs,
  onJumpToHunk,
}: {
  review: FileReview;
  abs: string;
  onJumpToHunk: (absPath: string, line: number) => void;
}) {
  // A fold with index `i` sits before hunk `i`; index === hunks.length sits after the last.
  const foldsByIndex = useMemo(() => {
    const m = new Map<number, FileReview['folds'][number]>();
    for (const f of review.folds) m.set(f.index, f);
    return m;
  }, [review]);

  const rows: JSX.Element[] = [];
  for (let i = 0; i <= review.hunks.length; i++) {
    const fold = foldsByIndex.get(i);
    if (fold) {
      rows.push(<FoldRow key={`fold-${i}`} fold={fold} />);
    }
    const hunk = review.hunks[i];
    if (hunk) {
      rows.push(<Hunk key={`hunk-${i}`} hunk={hunk} abs={abs} onJumpToHunk={onJumpToHunk} />);
    }
  }
  return <div className="rhunks">{rows}</div>;
}

// How many lines each "expand up/down" click reveals from a fold.
const FOLD_STEP = 10;

/**
 * A collapsed run of unchanged lines between hunks, revealable incrementally from the top
 * or bottom (or all at once), like GitHub's diff expanders.
 */
function FoldRow({ fold }: { fold: FileReview['folds'][number] }) {
  const total = fold.lines.length;
  const [topShown, setTopShown] = useState(0);
  const [botShown, setBotShown] = useState(0);
  const hidden = Math.max(0, total - topShown - botShown);
  const topLines = fold.lines.slice(0, topShown);
  const botLines = botShown > 0 ? fold.lines.slice(total - botShown) : [];

  const expandTop = () => setTopShown((n) => Math.min(total - botShown, n + FOLD_STEP));
  const expandBottom = () => setBotShown((n) => Math.min(total - topShown, n + FOLD_STEP));
  const expandAll = () => {
    setTopShown(total);
    setBotShown(0);
  };

  return (
    <div className="rfold">
      {topLines.map((l) => (
        <Line key={l.seq} line={l} />
      ))}
      {hidden > 0 && (
        <div className="rfold__bar">
          <button
            type="button"
            className="rfold__exp"
            onClick={expandTop}
            title="Show lines above"
            aria-label="Show lines above"
          >
            <IconChevron size={12} className="rfold__chev rfold__chev--up" />
          </button>
          <button type="button" className="rfold__count" onClick={expandAll} title="Show all">
            {hidden} unchanged line{hidden === 1 ? '' : 's'}
          </button>
          <button
            type="button"
            className="rfold__exp"
            onClick={expandBottom}
            title="Show lines below"
            aria-label="Show lines below"
          >
            <IconChevron size={12} className="rfold__chev rfold__chev--down" />
          </button>
        </div>
      )}
      {botLines.map((l) => (
        <Line key={l.seq} line={l} />
      ))}
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
