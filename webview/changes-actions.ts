import type { GitOp } from '../src/git-actions';
import type { ChangeDTO } from '../src/protocol';
import type { MenuItem } from './components/context-menu';
import type { GitActionIntent, IntentOp } from './git-intent';

/** The Changes kebab's five bulk git actions. Shared with the review navigator's own kebab so
 *  the two menus can't drift apart. */
export function buildBulkMenuItems(
  staged: ChangeDTO[],
  unstaged: ChangeDTO[],
  onAction: (intent: GitActionIntent) => void,
  close: () => void,
): MenuItem[] {
  const run = (op: IntentOp) => () => {
    onAction({ op });
    close();
  };
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
