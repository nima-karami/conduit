/**
 * Git branch/worktree indicator (Slice A — read-only). Renders in the E3 breadcrumb
 * band above the terminal, mirroring `.breadcrumb-bar`'s surface but signed with git
 * semantics: a branch glyph, a `--blue` worktree marker, an `--amber` dirty dot, and a
 * small-caps `--amber` operation badge. Segments are static, non-interactive text in
 * Slice A (the switcher dropdown is Slice B).
 *
 * GitInfo is produced host-side (src/git-info.ts) and rides the `state` broadcast on
 * `session.git`; this component only reads it. When the host bridge is absent (fake-shell
 * preview) `session.git` is simply never set, so the bar doesn't render — no host call.
 */
import type { GitInfo, GitOperation } from '../../src/types';
import { IconBranch, IconWorktree } from '../icons';

/** Externalized user-facing copy (branch names / SHAs / worktree names are user data). */
const STR = {
  groupLabel: 'Git branch',
  detached: 'detached',
  noCommits: 'no commits',
  bare: 'bare',
  uncommitted: 'Uncommitted changes',
  branchName: (b: string) => `Branch ${b}`,
  detachedAt: (sha: string) => `Detached at ${sha}`,
  worktreeName: (w: string) => `Worktree ${w}`,
  uncommittedSuffix: ', uncommitted changes',
} as const;

/** Operation badge label per in-progress git operation (e.g. REBASING). */
const OPERATION_LABEL: Record<GitOperation, string> = {
  rebase: 'REBASING',
  merge: 'MERGING',
  'cherry-pick': 'CHERRY-PICKING',
  revert: 'REVERTING',
  bisect: 'BISECTING',
};

export function GitIndicatorBar({ git }: { git: GitInfo | undefined }) {
  // No repo / error / interrogation-not-done → no band (spec D-4: absence is the signal).
  if (!git || git.kind === 'none') return null;

  return (
    <div className="git-indicator" role="group" aria-label={STR.groupLabel}>
      {git.isWorktree && git.worktreeName && (
        <>
          <span
            className="git-indicator__seg git-indicator__worktree"
            title={git.worktreeName}
            aria-label={STR.worktreeName(git.worktreeName)}
          >
            <IconWorktree size={12} className="git-indicator__glyph" />
            <span className="git-indicator__label" dir="ltr">
              {git.worktreeName}
            </span>
          </span>
          <span className="git-indicator__sep" aria-hidden>
            /
          </span>
        </>
      )}

      {git.kind === 'bare' && (
        <span className="git-indicator__seg" aria-label={STR.bare}>
          <IconBranch size={12} className="git-indicator__glyph" />
          <span className="git-indicator__op">{STR.bare}</span>
        </span>
      )}

      {git.kind === 'branch' && (
        <LabelSegment
          text={git.branch ?? ''}
          tag={git.unborn ? STR.noCommits : undefined}
          dirty={git.dirty}
          op={git.operation}
          accessibleName={`${opPrefix(git.operation)}${STR.branchName(git.branch ?? '')}${dirtySuffix(git.dirty)}`}
        />
      )}

      {git.kind === 'detached' && (
        <LabelSegment
          text={git.sha ?? ''}
          detached
          tag={STR.detached}
          dirty={git.dirty}
          op={git.operation}
          accessibleName={`${opPrefix(git.operation)}${STR.detachedAt(git.sha ?? '')}${dirtySuffix(git.dirty)}`}
        />
      )}
    </div>
  );
}

const opPrefix = (op: GitOperation | undefined) => (op ? `${OPERATION_LABEL[op]} ` : '');
const dirtySuffix = (dirty: boolean | undefined) => (dirty ? STR.uncommittedSuffix : '');

function OperationBadge({ op }: { op: GitOperation | undefined }) {
  if (!op) return null;
  return <span className="git-indicator__op">{OPERATION_LABEL[op]}</span>;
}

function DirtyDot({ dirty }: { dirty: boolean | undefined }) {
  if (!dirty) return null;
  // Conveyed in the segment's accessible name too (color is never the only signal).
  return <span className="git-indicator__dirty" title={STR.uncommitted} aria-hidden />;
}

/** One branch/detached/worktree-style segment. The branch and detached cases differ only
 * in the label text, the `--detached` class, and the trailing tag, so they share this. */
function LabelSegment({
  text,
  detached,
  tag,
  dirty,
  op,
  accessibleName,
}: {
  text: string;
  detached?: boolean;
  tag?: string | undefined;
  dirty: boolean | undefined;
  op: GitOperation | undefined;
  accessibleName: string;
}) {
  return (
    <span
      className={`git-indicator__seg git-indicator__branch${detached ? ' git-indicator__branch--detached' : ''}`}
      title={text}
      aria-label={accessibleName}
    >
      <OperationBadge op={op} />
      <IconBranch size={12} className="git-indicator__glyph" />
      <span className="git-indicator__label" dir="ltr">
        {text}
      </span>
      {tag && <span className="git-indicator__tag">{tag}</span>}
      <DirtyDot dirty={dirty} />
    </span>
  );
}
