import { folderKey } from './folder-key';
import type { GitInfo, GitOperation } from './types';

const STR = {
  detached: 'detached',
  noCommits: 'no commits',
  bare: 'bare',
  branchName: (b: string) => `Branch ${b}`,
  detachedAt: (sha: string) => `Detached at ${sha}`,
  worktree: (w: string) => `, worktree ${w}`,
  uncommitted: ', uncommitted changes',
  menuHint: '. Switch branch or view history',
  bareName: 'Bare repository. View history',
  switchedTo: (b: string) => `Switched to ${b}`,
  refuseBusy: "Can't switch while the terminal is busy.",
  refuseDirty: 'Commit or stash changes first.',
  switchFailed: (msg: string) => `Couldn't switch branch: ${msg}`,
  unknownRepo: 'unknown repository',
} as const;

const OPERATION_LABEL: Record<GitOperation, string> = {
  rebase: 'REBASING',
  merge: 'MERGING',
  'cherry-pick': 'CHERRY-PICKING',
  revert: 'REVERTING',
  bisect: 'BISECTING',
};

export type BranchChipModel =
  | { state: 'unknown' }
  | { state: 'none' }
  | {
      state: 'ready';
      kind: 'branch' | 'detached' | 'bare';
      text: string;
      tag?: 'detached' | 'no commits';
      op?: GitOperation;
      opLabel?: string;
      worktree?: string;
      dirty: boolean;
      switchable: boolean;
      accessibleName: string;
    };

export function branchChipModel(g: GitInfo | undefined): BranchChipModel {
  if (!g) return { state: 'unknown' };
  if (g.kind === 'none') return { state: 'none' };
  const worktree = g.isWorktree && g.worktreeName ? g.worktreeName : undefined;
  if (g.kind === 'bare') {
    return {
      state: 'ready',
      kind: 'bare',
      text: STR.bare,
      ...(worktree ? { worktree } : {}),
      dirty: false,
      switchable: false,
      accessibleName: STR.bareName,
    };
  }
  const dirty = !!g.dirty;
  const opLabel = g.operation ? OPERATION_LABEL[g.operation] : undefined;
  const detached = g.kind === 'detached';
  const text = (detached ? g.sha : g.branch) ?? '';
  const tag = detached ? STR.detached : g.unborn ? STR.noCommits : undefined;
  const accessibleName = `${opLabel ? `${opLabel} ` : ''}${
    detached ? STR.detachedAt(text) : STR.branchName(text)
  }${worktree ? STR.worktree(worktree) : ''}${dirty ? STR.uncommitted : ''}${STR.menuHint}`;
  return {
    state: 'ready',
    kind: g.kind,
    text,
    ...(tag ? { tag } : {}),
    ...(g.operation ? { op: g.operation, opLabel } : {}),
    ...(worktree ? { worktree } : {}),
    dirty,
    switchable: detached || !g.unborn,
    accessibleName,
  };
}

export type SwitchOutcome = { announce: string } | { toast: string; variant: 'info' | 'error' };

export function switchOutcome(
  msg: { ok: boolean; reason?: 'busy' | 'dirty' | 'failed'; message?: string },
  requestedRef: string,
): SwitchOutcome {
  if (msg.ok) return { announce: STR.switchedTo(requestedRef) };
  if (msg.reason === 'busy') return { toast: STR.refuseBusy, variant: 'info' };
  if (msg.reason === 'dirty') return { toast: STR.refuseDirty, variant: 'info' };
  const detail = msg.message === 'unknown repo' ? STR.unknownRepo : (msg.message ?? '');
  return { toast: STR.switchFailed(detail), variant: 'error' };
}

export function acceptsRepoResult(
  msg: { sessionId: string; repoRoot?: string },
  sessionId: string,
  repoRoot: string,
): boolean {
  return msg.sessionId === sessionId && folderKey(msg.repoRoot ?? '') === folderKey(repoRoot);
}
