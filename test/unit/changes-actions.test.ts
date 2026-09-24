import { describe, expect, it } from 'vitest';
import type { GitActionResult } from '../../src/git-actions';
import type { ChangeDTO } from '../../src/protocol';
import {
  buildBulkMenuItems,
  type DiscardStep,
  discardAllPlan,
  rowActionsFor,
  runDiscardAll,
} from '../../webview/changes-actions';
import type { GitActionIntent } from '../../webview/git-intent';

const ch = (path: string, staged: boolean, kind: ChangeDTO['kind'] = 'M'): ChangeDTO => ({
  path,
  added: 1,
  removed: 0,
  kind,
  staged,
});

const PER_REPO = 'Works on one repo. Right-click a repo header, or switch to Active repo.';

function build(
  staged: ChangeDTO[],
  unstaged: ChangeDTO[],
  scope: Parameters<typeof buildBulkMenuItems>[4],
) {
  const intents: GitActionIntent[] = [];
  let closed = 0;
  const items = buildBulkMenuItems(
    staged,
    unstaged,
    (i) => intents.push(i),
    () => {
      closed++;
    },
    scope,
  );
  const byLabel = (label: string) => {
    const it = items.find((x) => x.label === label);
    if (!it) throw new Error(`no ${label}`);
    return it;
  };
  return { items, intents, byLabel, closed: () => closed };
}

describe('buildBulkMenuItems', () => {
  it('repo scope: every intent carries repoRoot', () => {
    const { items, intents, closed } = build([ch('a', true)], [ch('b', false)], {
      kind: 'repo',
      repoRoot: '/r/a',
    });
    expect(items.map((i) => i.label)).toEqual([
      'Stage all',
      'Unstage all',
      'Stash changes',
      'Pop stash',
      'Discard all changes',
    ]);
    for (const it of items) it.onClick();
    expect(intents).toEqual([
      { op: 'stageAll', repoRoot: '/r/a' },
      { op: 'unstageAll', repoRoot: '/r/a' },
      { op: 'stashPush', repoRoot: '/r/a' },
      { op: 'stashPop', repoRoot: '/r/a' },
      { op: 'discardAll', repoRoot: '/r/a' },
    ]);
    expect(closed()).toBe(5);
  });

  it('repo scope, exact: Stage / Unstage / Discard carry exactly the passed paths', () => {
    const { byLabel, intents } = build(
      [ch('a', true), ch('m', true)],
      [ch('m', false), ch('u', false, 'U')],
      { kind: 'repo', repoRoot: '/r/a', exact: true },
    );
    for (const label of ['Stage all', 'Unstage all', 'Discard all changes', 'Stash changes'])
      byLabel(label).onClick();
    expect(intents).toEqual([
      { op: 'stageAll', repoRoot: '/r/a', paths: ['m', 'u'] },
      { op: 'unstageAll', repoRoot: '/r/a', paths: ['a', 'm'] },
      { op: 'discardAll', repoRoot: '/r/a', paths: ['a', 'm', 'u'] },
      { op: 'stashPush', repoRoot: '/r/a' },
    ]);
  });

  it('repo scope keeps the disabled rules', () => {
    const { byLabel } = build([], [], { kind: 'repo', repoRoot: '/r/a' });
    expect(byLabel('Stage all').disabled).toBe(true);
    expect(byLabel('Unstage all').disabled).toBe(true);
    expect(byLabel('Discard all changes').disabled).toBe(true);
    expect(byLabel('Stash changes').disabled).toBeFalsy();
  });

  it('all scope: Stage all → targets = stage; disabled when none', () => {
    const on = build([], [ch('b', false)], {
      kind: 'all',
      stage: [{ root: '/r/a' }, { root: '/r/b' }],
      unstage: [{ root: '/r/b' }],
    });
    on.byLabel('Stage all').onClick();
    on.byLabel('Unstage all').onClick();
    expect(on.intents).toEqual([
      { op: 'stageAll', targets: [{ root: '/r/a' }, { root: '/r/b' }] },
      { op: 'unstageAll', targets: [{ root: '/r/b' }] },
    ]);
    expect(on.byLabel('Stage all').disabled).toBe(false);
    const off = build([], [], { kind: 'all', stage: [], unstage: [] });
    expect(off.byLabel('Stage all').disabled).toBe(true);
    expect(off.byLabel('Unstage all').disabled).toBe(true);
  });

  it('all scope: Stash, Pop, Discard disabled with the per-repo title', () => {
    const { byLabel, items } = build([ch('a', true)], [ch('b', false)], {
      kind: 'all',
      stage: [{ root: '/r/a' }],
      unstage: [{ root: '/r/a' }],
    });
    for (const label of ['Stash changes', 'Pop stash', 'Discard all changes']) {
      expect(byLabel(label).disabled).toBe(true);
      expect(byLabel(label).title).toBe(PER_REPO);
    }
    expect(items.map((i) => i.label)).toEqual([
      'Stage all',
      'Unstage all',
      'Stash changes',
      'Pop stash',
      'Discard all changes',
    ]);
  });

  it('all scope with perRepoTitle uses it on Stash/Pop/Discard', () => {
    const { byLabel } = build([ch('a', true)], [ch('b', false)], {
      kind: 'all',
      stage: [{ root: '/r/a' }],
      unstage: [{ root: '/r/a' }],
      perRepoTitle: 'Pick one repo first',
    });
    for (const label of ['Stash changes', 'Pop stash', 'Discard all changes']) {
      expect(byLabel(label).disabled).toBe(true);
      expect(byLabel(label).title).toBe('Pick one repo first');
    }
    expect(byLabel('Stage all').title).toBe('Stage every changed file in 1 repo');
  });

  it('omitted → STR.perRepoOnly', () => {
    const { byLabel } = build([], [], { kind: 'all', stage: [], unstage: [] });
    for (const label of ['Stash changes', 'Pop stash', 'Discard all changes']) {
      expect(byLabel(label).title).toBe(
        'Works on one repo. Right-click a repo header, or switch to Active repo.',
      );
    }
  });

  it('all scope Stage all title names N repos', () => {
    const { byLabel } = build([ch('a', true)], [ch('b', false)], {
      kind: 'all',
      stage: [{ root: '/r/a' }, { root: '/r/b' }],
      unstage: [{ root: '/r/a' }],
    });
    expect(byLabel('Stage all').title).toBe('Stage every changed file in 2 repos');
    expect(byLabel('Unstage all').title).toBe('Unstage every staged file in 1 repo');
  });
});

describe('discardAllPlan', () => {
  const changes = [
    ch('a', true),
    ch('m', true),
    ch('m', false),
    ch('u', false, 'U'),
    ch('.conduit/review-notes.json', false, 'U'),
  ];

  it('named paths: only those, counted once per path, unstaging only their staged sides', () => {
    expect(discardAllPlan(changes, ['a', 'm', 'u'])).toEqual({
      count: 3,
      unstage: ['a', 'm'],
      restore: ['a', 'm'],
      remove: ['u'],
    });
  });

  it('no paths: the whole repo, as the Changes tab lists it', () => {
    expect(discardAllPlan(changes)).toEqual({
      count: 5,
      unstage: undefined,
      restore: ['a', 'm'],
      remove: ['u', '.conduit/review-notes.json'],
    });
  });

  // Once unstaged, a rename's destination and a staged add are untracked: `git restore` would
  // refuse them, and the rename's source has to come back from HEAD.
  it('a staged rename unstages both sides, restores the source and deletes the destination', () => {
    const renamed: ChangeDTO = { ...ch('new', true), origPath: 'old' };
    const list = [renamed, ch('new', false), ch('added', true, 'A'), ch('m', false)];
    expect(discardAllPlan(list, ['new', 'added', 'm'])).toEqual({
      count: 3,
      unstage: ['new', 'old', 'added'],
      restore: ['old', 'm'],
      remove: ['new', 'added'],
    });
    expect(discardAllPlan(list)).toMatchObject({ restore: ['old', 'm'], remove: ['new', 'added'] });
  });
});

describe('runDiscardAll', () => {
  const plan = { count: 2, unstage: ['new', 'old'], restore: ['old', 'm'], remove: ['new'] };
  const recorder = (failAt?: number) => {
    const steps: DiscardStep[] = [];
    const run = async (step: DiscardStep): Promise<GitActionResult> => {
      steps.push(step);
      return steps.length === failAt ? { ok: false, error: 'index.lock exists' } : { ok: true };
    };
    return { steps, run };
  };

  it('unstages, then restores, then deletes, one step after another', async () => {
    const { steps, run } = recorder();
    expect(await runDiscardAll(plan, run)).toEqual({ ok: true });
    expect(steps).toEqual([
      { op: 'unstageAll', paths: ['new', 'old'] },
      { op: 'discardTracked', path: 'old' },
      { op: 'discardTracked', path: 'm' },
      { op: 'discardUntracked', path: 'new' },
    ]);
  });

  it('a failed unstage stops it before any restore or delete, and returns the failure', async () => {
    const { steps, run } = recorder(1);
    expect(await runDiscardAll(plan, run)).toEqual({ ok: false, error: 'index.lock exists' });
    expect(steps).toHaveLength(1);
  });

  it('a failed restore stops it before any delete', async () => {
    const { steps, run } = recorder(2);
    expect((await runDiscardAll(plan, run)).ok).toBe(false);
    expect(steps.map((s) => s.op)).toEqual(['unstageAll', 'discardTracked']);
  });

  it('whole-repo plans unstage everything; an empty unstage list is skipped', async () => {
    const whole = recorder();
    await runDiscardAll({ ...plan, unstage: undefined }, whole.run);
    expect(whole.steps[0]).toEqual({ op: 'unstageAll' });
    const none = recorder();
    await runDiscardAll({ ...plan, unstage: [] }, none.run);
    expect(none.steps[0]).toEqual({ op: 'discardTracked', path: 'old' });
  });
});

describe('rowActionsFor', () => {
  it('rowActionsFor unchanged', () => {
    expect(rowActionsFor(ch('a', true)).map((a) => a.op)).toEqual(['unstageFile']);
    expect(rowActionsFor(ch('a', false)).map((a) => a.op)).toEqual(['stageFile', 'discardTracked']);
    expect(rowActionsFor(ch('a', false, 'U')).map((a) => a.op)).toEqual([
      'stageFile',
      'discardUntracked',
    ]);
  });
});
