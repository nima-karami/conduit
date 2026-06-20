/**
 * Git branch/worktree indicator. Slice A is read-only status; Slice B makes the BRANCH
 * segment an in-place switcher: a `role="button"` that opens a dropdown of local branches
 * and posts `git:switch` host-side. The host enforces the safe semantics (refuse while the
 * terminal is busy or the tree is dirty; validate the ref against its own enumerated set) —
 * the renderer never spawns git.
 *
 * GitInfo is produced host-side (src/git-info.ts) and rides the `state` broadcast on
 * `session.git`; this component only reads it. When the host bridge is absent (fake-shell
 * preview) `session.git` is never set, so the bar (and the switcher) don't render — no host
 * call. Switch outcomes are announced via an `aria-live` region; an external `cd`/checkout
 * is NOT announced (Slice A behavior unchanged) — only user-initiated switches.
 */
import { forwardRef, useEffect, useRef, useState } from 'react';
import type { GitInfo, GitOperation } from '../../src/types';
import { post, subscribe } from '../bridge';
import { IconBranch, IconHistory, IconWorktree } from '../icons';
import { pushToast } from '../toast-store';
import { BranchSwitcherMenu } from './branch-switcher-menu';

/** Externalized user-facing copy (branch names / SHAs / worktree names are user data). */
const STR = {
  groupLabel: 'Git branch',
  detached: 'detached',
  noCommits: 'no commits',
  bare: 'bare',
  uncommitted: 'Uncommitted changes',
  history: 'View commit history',
  branchName: (b: string) => `Branch ${b}`,
  detachedAt: (sha: string) => `Detached at ${sha}`,
  worktreeName: (w: string) => `Worktree ${w}`,
  uncommittedSuffix: ', uncommitted changes',
  switchTo: (b: string) => `Switch branch (current: ${b})`,
  switchedTo: (b: string) => `Switched to ${b}`,
  refuseBusy: "Can't switch while the terminal is busy.",
  refuseDirty: 'Commit or stash changes first.',
  switchFailed: (msg: string) => `Couldn't switch branch: ${msg}`,
} as const;

/** Operation badge label per in-progress git operation (e.g. REBASING). */
const OPERATION_LABEL: Record<GitOperation, string> = {
  rebase: 'REBASING',
  merge: 'MERGING',
  'cherry-pick': 'CHERRY-PICKING',
  revert: 'REVERTING',
  bisect: 'BISECTING',
};

export function GitIndicatorBar({
  git,
  sessionId,
  onOpenHistory,
}: {
  git: GitInfo | undefined;
  /** Active session id — the target for `git:refs` / `git:switch`. Absent in odd render
   *  states; the switcher stays a plain status segment without it. */
  sessionId?: string;
  /** Open the commit-history graph for the active session (git-history Slice A). The
   *  button only renders when git is present (this whole bar returns null otherwise). */
  onOpenHistory?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [announce, setAnnounce] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A named branch (not unborn) is switchable; detached MAY switch to a branch (that leaves
  // detached). Unborn/bare have nothing to switch to. Needs a sessionId for the host calls.
  const switchable =
    !!sessionId && ((git?.kind === 'branch' && !git.unborn) || git?.kind === 'detached');

  // Listen for the switch result for THIS session: announce + toast the outcome, close
  // the menu, clear the inline switching state. ok:true relies on the host's scheduled
  // git refresh to update the indicator (no optimistic mutation here).
  useEffect(() => {
    if (!sessionId) return;
    return subscribe((msg) => {
      if (msg.type !== 'git:switchResult' || msg.sessionId !== sessionId) return;
      setSwitching(false);
      setMenuOpen(false);
      if (msg.ok) {
        // The new branch name arrives on the next state; announce the result generically
        // here (the indicator itself reflects the name once it lands).
        setAnnounce(STR.switchedTo(''));
        return;
      }
      const copy =
        msg.reason === 'busy'
          ? STR.refuseBusy
          : msg.reason === 'dirty'
            ? STR.refuseDirty
            : STR.switchFailed(msg.message ?? '');
      setAnnounce(copy);
      pushToast({ message: copy, variant: msg.reason === 'failed' ? 'error' : 'info' });
    });
  }, [sessionId]);

  // Return focus to the trigger when the menu closes (a11y §10).
  useEffect(() => {
    if (!menuOpen) triggerRef.current?.focus();
  }, [menuOpen]);

  // No repo / error / interrogation-not-done → no band (spec D-4: absence is the signal).
  if (!git || git.kind === 'none') return null;

  const openMenu = () => {
    if (!switchable || switching) return;
    setMenuOpen(true);
  };

  const onSelect = (ref: string) => {
    if (!sessionId) return;
    setSwitching(true);
    post({ type: 'git:switch', sessionId, target: { kind: 'branch', ref } });
  };

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
          ref={triggerRef}
          text={git.branch ?? ''}
          tag={git.unborn ? STR.noCommits : undefined}
          dirty={git.dirty}
          op={git.operation}
          switchable={switchable}
          switching={switching}
          menuOpen={menuOpen}
          onActivate={openMenu}
          accessibleName={
            switchable
              ? STR.switchTo(git.branch ?? '')
              : `${opPrefix(git.operation)}${STR.branchName(git.branch ?? '')}${dirtySuffix(git.dirty)}`
          }
        />
      )}

      {git.kind === 'detached' && (
        <LabelSegment
          ref={triggerRef}
          text={git.sha ?? ''}
          detached
          tag={STR.detached}
          dirty={git.dirty}
          op={git.operation}
          switchable={switchable}
          switching={switching}
          menuOpen={menuOpen}
          onActivate={openMenu}
          accessibleName={`${opPrefix(git.operation)}${STR.detachedAt(git.sha ?? '')}${dirtySuffix(git.dirty)}`}
        />
      )}

      {menuOpen && sessionId && (
        <BranchSwitcherMenu
          sessionId={sessionId}
          switching={switching}
          triggerRef={triggerRef}
          onSelect={onSelect}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {onOpenHistory && (
        <button
          type="button"
          className="git-indicator__history"
          title={STR.history}
          aria-label={STR.history}
          onClick={onOpenHistory}
        >
          <IconHistory size={13} />
        </button>
      )}

      <div className="git-indicator__live" role="status" aria-live="polite">
        {announce}
      </div>
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

/** One branch/detached segment. When `switchable`, it's a `role="button"` that opens the
 * switcher; otherwise it renders the same content as inert status text. The branch and
 * detached cases differ only in the label text, the `--detached` class, and the tag. */
const LabelSegment = forwardRef<
  HTMLButtonElement,
  {
    text: string;
    detached?: boolean;
    tag?: string | undefined;
    dirty: boolean | undefined;
    op: GitOperation | undefined;
    switchable: boolean;
    switching: boolean;
    menuOpen: boolean;
    onActivate: () => void;
    accessibleName: string;
  }
>(function LabelSegment(
  { text, detached, tag, dirty, op, switchable, switching, menuOpen, onActivate, accessibleName },
  ref,
) {
  const cls = `git-indicator__seg git-indicator__branch${
    detached ? ' git-indicator__branch--detached' : ''
  }${switchable ? ' git-indicator__branch--switchable' : ''}`;
  const inner = (
    <>
      <OperationBadge op={op} />
      <IconBranch size={12} className="git-indicator__glyph" />
      <span className="git-indicator__label" dir="ltr">
        {text}
      </span>
      {tag && <span className="git-indicator__tag">{tag}</span>}
      <DirtyDot dirty={dirty} />
    </>
  );

  if (!switchable) {
    return (
      <span className={cls} title={text} aria-label={accessibleName}>
        {inner}
      </span>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      className={cls}
      title={text}
      aria-label={accessibleName}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      disabled={switching}
      onClick={onActivate}
    >
      {inner}
    </button>
  );
});
