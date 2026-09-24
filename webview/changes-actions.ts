import type { GitOp } from '../src/git-actions';
import { countNoun } from '../src/menu-selection';
import type { ChangeDTO } from '../src/protocol';
import type { MenuItem } from './components/context-menu';
import type { BulkTarget, GitActionIntent, IntentOp } from './git-intent';

const STR = {
  perRepoOnly: 'Works on one repo. Right-click a repo header, or switch to Active repo.',
  stageAcross: (n: number) => `Stage every changed file in ${countNoun(n, 'repo', 'repos')}`,
  unstageAcross: (n: number) => `Unstage every staged file in ${countNoun(n, 'repo', 'repos')}`,
} as const;

/** `all` targets are the repos with at least one unstaged (`stage`) / staged (`unstage`)
 *  change. `exact`: Stage / Unstage / Discard all act on exactly the passed entries' paths rather
 *  than the whole repo — Review's lists leave out its own notes file. */
export type BulkScope =
  | { kind: 'repo'; repoRoot: string; exact?: boolean }
  | { kind: 'all'; stage: BulkTarget[]; unstage: BulkTarget[]; perRepoTitle?: string };

const uniquePaths = (changes: readonly ChangeDTO[]): string[] => [
  ...new Set(changes.map((c) => c.path)),
];

/** The paths an exact-list bulk op names for `changes`: a staged rename's source too, or
 *  unstaging it would leave the source's deletion staged. */
export const bulkPaths = (changes: readonly ChangeDTO[]): string[] => [
  ...new Set(changes.flatMap((c) => (c.origPath === undefined ? [c.path] : [c.path, c.origPath]))),
];

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
        onClick: fire({ op: 'stageAll', targets: scope.stage }),
        disabled: scope.stage.length === 0,
        title: STR.stageAcross(scope.stage.length),
      },
      {
        label: 'Unstage all',
        onClick: fire({ op: 'unstageAll', targets: scope.unstage }),
        disabled: scope.unstage.length === 0,
        title: STR.unstageAcross(scope.unstage.length),
      },
      { label: 'Stash changes', separatorBefore: true, ...perRepo },
      { label: 'Pop stash', ...perRepo },
      { label: 'Discard all changes', danger: true, separatorBefore: true, ...perRepo },
    ];
  }
  const run = (op: IntentOp, over?: readonly ChangeDTO[]) =>
    fire({
      op,
      repoRoot: scope.repoRoot,
      ...(scope.exact && over ? { paths: bulkPaths(over) } : {}),
    });
  return [
    { label: 'Stage all', onClick: run('stageAll', unstaged), disabled: unstaged.length === 0 },
    { label: 'Unstage all', onClick: run('unstageAll', staged), disabled: staged.length === 0 },
    { label: 'Stash changes', separatorBefore: true, onClick: run('stashPush') },
    { label: 'Pop stash', onClick: run('stashPop') },
    {
      label: 'Discard all changes',
      danger: true,
      separatorBefore: true,
      onClick: run('discardAll', [...staged, ...unstaged]),
      disabled: staged.length === 0 && unstaged.length === 0,
    },
  ];
}

export interface DiscardAllPlan {
  /** What the confirm counts. */
  count: number;
  /** Paths to unstage first; undefined = the whole index. */
  unstage: string[] | undefined;
  restore: string[];
  remove: string[];
}

/** Discard all over one repo's `changes`, or only the entries under `paths` when the caller
 *  names them. */
export function discardAllPlan(
  changes: readonly ChangeDTO[],
  paths?: readonly string[],
): DiscardAllPlan {
  const only = paths === undefined ? undefined : new Set(paths);
  const list = only === undefined ? changes : changes.filter((c) => only.has(c.path));
  // A path HEAD lacks (staged add, rename or copy destination) is untracked once unstaged, so
  // it is deleted rather than restored; a rename's source is restored from HEAD.
  const sources = new Set(list.flatMap((c) => (c.origPath === undefined ? [] : [c.origPath])));
  const remove = new Set(
    list
      .filter((c) => c.kind === 'U' || (c.staged && (c.kind === 'A' || c.origPath !== undefined)))
      .map((c) => c.path)
      .filter((p) => !sources.has(p)),
  );
  const restore = new Set(sources);
  for (const c of list) if (!remove.has(c.path)) restore.add(c.path);
  return {
    count: only === undefined ? list.length : uniquePaths(list).length,
    unstage: only === undefined ? undefined : bulkPaths(list.filter((c) => c.staged)),
    restore: [...restore],
    remove: [...remove],
  };
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
