import type { GitOp } from '../src/git-actions';
import { countNoun } from '../src/menu-selection';
import type { ChangeDTO } from '../src/protocol';
import type { MenuItem } from './components/context-menu';
import type { GitActionIntent, IntentOp } from './git-intent';

const STR = {
  perRepoOnly: 'Works on one repo. Right-click a repo header, or switch to Active repo.',
  stageAcross: (n: number) => `Stage every changed file in ${countNoun(n, 'repo', 'repos')}`,
  unstageAcross: (n: number) => `Unstage every staged file in ${countNoun(n, 'repo', 'repos')}`,
} as const;

/** `all` roots are the repos with at least one unstaged (`stageRoots`) / staged
 *  (`unstageRoots`) change. */
export type BulkScope =
  | { kind: 'repo'; repoRoot: string }
  | { kind: 'all'; stageRoots: string[]; unstageRoots: string[]; perRepoTitle?: string };

/** The Changes kebab's five bulk git actions. Shared with the review navigator's own kebab and
 *  the row / repo-head menus so they can't drift apart. Across repos only Stage/Unstage all fan
 *  out; the rest are per repo (locked L11). */
export function buildBulkMenuItems(
  staged: ChangeDTO[],
  unstaged: ChangeDTO[],
  onAction: (intent: GitActionIntent) => void,
  close: () => void,
  scope: BulkScope,
): MenuItem[] {
  const fire = (intent: GitActionIntent) => () => {
    onAction(intent);
    close();
  };
  if (scope.kind === 'all') {
    const perRepo = {
      disabled: true,
      title: scope.perRepoTitle ?? STR.perRepoOnly,
      onClick: () => {},
    };
    return [
      {
        label: 'Stage all',
        onClick: fire({ op: 'stageAll', repoRoots: scope.stageRoots }),
        disabled: scope.stageRoots.length === 0,
        title: STR.stageAcross(scope.stageRoots.length),
      },
      {
        label: 'Unstage all',
        onClick: fire({ op: 'unstageAll', repoRoots: scope.unstageRoots }),
        disabled: scope.unstageRoots.length === 0,
        title: STR.unstageAcross(scope.unstageRoots.length),
      },
      { label: 'Stash changes', separatorBefore: true, ...perRepo },
      { label: 'Pop stash', ...perRepo },
      { label: 'Discard all changes', danger: true, separatorBefore: true, ...perRepo },
    ];
  }
  const run = (op: IntentOp) => fire({ op, repoRoot: scope.repoRoot });
  return [
    { label: 'Stage all', onClick: run('stageAll'), disabled: unstaged.length === 0 },
    { label: 'Unstage all', onClick: run('unstageAll'), disabled: staged.length === 0 },
    { label: 'Stash changes', separatorBefore: true, onClick: run('stashPush') },
    { label: 'Pop stash', onClick: run('stashPop') },
    {
      label: 'Discard all changes',
      danger: true,
      separatorBefore: true,
      onClick: run('discardAll'),
      disabled: staged.length === 0 && unstaged.length === 0,
    },
  ];
}

/** The hover actions on one change row, in both the status list and the review navigator. */
export function rowActionsFor(
  change: ChangeDTO,
): { label: string; op: GitOp; danger?: boolean; title: string }[] {
  if (change.staged) return [{ label: 'Unstage', op: 'unstageFile', title: 'Unstage this file' }];
  // Untracked discard via delete, tracked via git restore — pick the op from kind so the
  // confirm copy matches.
  return [
    { label: 'Stage', op: 'stageFile', title: 'Stage this file' },
    {
      label: 'Discard',
      op: change.kind === 'U' ? 'discardUntracked' : 'discardTracked',
      danger: true,
      title: change.kind === 'U' ? 'Delete untracked file' : 'Discard changes',
    },
  ];
}
