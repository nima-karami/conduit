import { describe, expect, it } from 'vitest';
import type { ChangeDTO } from '../../src/protocol';
import { buildBulkMenuItems, discardAllPlan, rowActionsFor } from '../../webview/changes-actions';
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
