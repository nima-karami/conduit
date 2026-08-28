import type { GitActionRequest, GitActionResult, HunkOp } from '../src/git-actions';
import type { HunkRange } from '../src/hunk-patch';
import type { ConfirmState } from './components/confirm-dialog';
import type { ReviewScope } from './review-scope';

/**
 * Hunk-level stage / unstage / discard, renderer side
 * (spec 2026-08-27-review-supercharge §2 Lane E).
 *
 * One module for BOTH surfaces — the Review hunk header and the editor's change peek — because
 * the rule about which button is offered, the copy, and the after-op sequence are the same in
 * each, and a second copy of any of the three would drift. The app-level capabilities the
 * sequence needs (the repo root, the confirm dialog, the change refresh, the diff cache) arrive
 * through the store at the bottom rather than as props: the peek sits four prop hops from
 * app.tsx, and the existing onGitAction prop is fire-and-forget where these must be awaited.
 */

export type HunkButtonMode = 'stage' | 'unstage' | 'blocked' | 'unmerged' | 'whitespace';

export const BLOCKED_TOOLTIP = 'Switch to Unstaged scope to stage hunks';
export const CONFLICT_TOAST = 'The file changed since this diff was loaded — refreshed.';
export const UNTRACKED_DISCARD_TOOLTIP =
  'A new file has no previous version — discard it from the Changes panel';
export const STAGED_DISCARD_TOOLTIP = 'Switch to Unstaged scope to discard hunks';
export const UNMERGED_TOOLTIP = 'Resolve the conflict before staging or discarding hunks';
export const WHITESPACE_TOOLTIP = 'Turn off Ignore whitespace to stage or discard hunks';
/** A commit or a comparison is a record of the past; there is nothing there to stage. */
export const NO_HUNK_OPS_TOOLTIP =
  'Hunk actions are only available when reviewing the working tree';

/**
 * Stage and Discard act on the index→worktree hunks. Under Unstaged the displayed ranges map
 * onto those 1:1; under All they do only while the file has no staged side. This is the whole
 * reason Lane D lands before Lane E (§2 Lane E "Baseline rule").
 */
export function hunkButtonMode(
  scope: ReviewScope,
  hasStagedSide: boolean,
  unmerged = false,
  ignoreWhitespace = false,
): HunkButtonMode {
  // A conflicted path has no stage-0 index blob, so no apply target exists on either side
  // (src/file-service.ts UNMERGED).
  if (unmerged) return 'unmerged';
  // The displayed hunks came from a whitespace-COLLAPSED diff; git's apply is whitespace
  // sensitive, so the line range names a different set of changes than the reader approved —
  // a discard would revert re-indents they were never shown. The two hunk lists do not
  // correspond index-for-index either, so there is nothing to recompute: refuse instead.
  if (ignoreWhitespace) return 'whitespace';
  if (scope === 'staged') return 'unstage';
  if (scope === 'unstaged') return 'stage';
  return hasStagedSide ? 'blocked' : 'stage';
}

export function discardConfirm(
  relPath: string,
  lineCount: number,
): Omit<ConfirmState, 'onConfirm'> {
  return {
    title: 'Discard this change?',
    message: `${lineCount} line${lineCount === 1 ? '' : 's'} in ${relPath} will be reverted to the index. This can't be undone.`,
    confirmLabel: 'Discard',
    danger: true,
    focusCancel: true,
  };
}

/** App-level capabilities one hunk op needs, published by app.tsx. */
export interface HunkActionHost {
  /** Active repo root; '' when there is no repo (every op is then a no-op). */
  root: string;
  /** Repo-relative posix paths that currently have a STAGED side (ChangeDTO.staged). Folded
   *  with foldRelPath — query it the same way or a Windows case mismatch reads as "no staged
   *  side" and stages the wrong hunk. */
  stagedPaths: ReadonlySet<string>;
  /** Repo-relative posix paths that are CONFLICTED, folded the same way. */
  conflictedPaths: ReadonlySet<string>;
  /** Resolves false on Cancel or Esc. */
  confirmDiscard(state: Omit<ConfirmState, 'onConfirm'>): Promise<boolean>;
  refreshChanges(): void;
  /** Drop the cached working diff for an ABSOLUTE path so its Review card refetches. */
  invalidateDiff(absPath: string): void;
}

export interface HunkActionRequest {
  op: HunkOp;
  /** Absolute path — what the diff cache is keyed by. */
  absPath: string;
  /** Repo-relative posix path — what git and the confirm copy want. */
  relPath: string;
  range: HunkRange;
  /** Lines this op touches; the discard confirm quotes it. */
  lineCount: number;
  untracked: boolean;
  /**
   * Hashes of the two sides of the diff this range was read off. The host re-reads both at op
   * time and refuses on a mismatch, so a range from a diff the file has since moved past can
   * never be honoured. Absent only where a surface genuinely has no diff to fingerprint.
   */
  expect?: { head: string; work: string };
}

export type HunkOutcome =
  | { kind: 'done'; op: HunkOp }
  | { kind: 'cancelled' }
  | { kind: 'unsupported' }
  | { kind: 'noHost' }
  | { kind: 'failed'; reason: 'no-hunk' | 'apply-failed' | 'other'; message?: string };

export interface HunkActionDeps {
  host: HunkActionHost | null;
  gitAction(req: GitActionRequest): Promise<GitActionResult>;
  toast(input: { message: string; variant: 'error' | 'info' }): void;
  announce(text: string): void;
}

const SAID: Record<HunkOp, string> = {
  stageHunk: 'Staged hunk',
  unstageHunk: 'Unstaged hunk',
  discardHunk: 'Discarded hunk',
};

export async function applyHunkAction(
  deps: HunkActionDeps,
  req: HunkActionRequest,
): Promise<HunkOutcome> {
  const { host } = deps;
  if (!host?.root) return { kind: 'noHost' };
  // An untracked file has no index entry, so `git apply --reverse` cannot express "put this
  // hunk back"; the whole-file discard in the Changes panel is the path (Lane E plan, 13).
  if (req.op === 'discardHunk' && req.untracked) return { kind: 'unsupported' };

  if (req.op === 'discardHunk') {
    const go = await host.confirmDiscard(discardConfirm(req.relPath, req.lineCount));
    if (!go) return { kind: 'cancelled' };
  }

  // §2 Lane E: "Untracked file: Stage = existing stageFile" — the whole file IS the hunk.
  const request: GitActionRequest =
    req.op === 'stageHunk' && req.untracked
      ? { root: host.root, op: 'stageFile', path: req.relPath }
      : {
          root: host.root,
          op: req.op,
          path: req.relPath,
          range: req.range,
          ...(req.expect === undefined ? {} : { expect: req.expect }),
        };

  const res = await deps.gitAction(request);
  if (res.ok) {
    deps.announce(SAID[req.op]);
    host.invalidateDiff(req.absPath);
    host.refreshChanges();
    return { kind: 'done', op: req.op };
  }

  const stale = res.error === 'no-hunk' || res.error === 'apply-failed';
  deps.toast({ message: stale ? CONFLICT_TOAST : `Git: ${res.error}`, variant: 'error' });
  // Even a rejected apply can coincide with a real on-disk change, so the card reloads either
  // way — the spec's "toast + card reload", never a blind retry (§2 Lane E).
  host.invalidateDiff(req.absPath);
  host.refreshChanges();
  return {
    kind: 'failed',
    reason:
      res.error === 'no-hunk' ? 'no-hunk' : res.error === 'apply-failed' ? 'apply-failed' : 'other',
    ...(res.message === undefined ? {} : { message: res.message }),
  };
}

// --- The host store ---------------------------------------------------------------------
// Same shape as webview/change-nav-registry.ts: a module-scope slot app.tsx fills and the two
// consuming surfaces read through useSyncExternalStore.

let current: HunkActionHost | null = null;
const listeners = new Set<() => void>();

/** Publish `host`; the returned teardown is identity-checked so a later publisher wins. */
export function setHunkActionHost(host: HunkActionHost | null): () => void {
  current = host;
  for (const cb of listeners) cb();
  return () => {
    if (current === host) {
      current = null;
      for (const cb of listeners) cb();
    }
  };
}

export function getHunkActionHost(): HunkActionHost | null {
  return current;
}

export function subscribeHunkActionHost(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
