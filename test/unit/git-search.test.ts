import { describe, expect, it } from 'vitest';
import {
  collectRefs,
  filterCommits,
  hasRef,
  isStaleHistory,
  matchesQuery,
  reachableFromRef,
  visibleRange,
} from '../../src/git-search';
import type { CommitNode, GitRef } from '../../src/protocol';

/** Terse CommitNode factory; refs/body/email/author overridable for the search cases. */
function c(partial: Partial<CommitNode> & { sha: string }): CommitNode {
  return {
    parents: [],
    refs: [],
    author: 'Ada Lovelace',
    date: 0,
    subject: 'subject',
    ...partial,
  };
}

const fixture: CommitNode[] = [
  c({
    sha: 'a1b2c3d4e5f600000000000000000000000000aa',
    subject: 'feat: add logging seam',
    body: 'Wires a log.<level>("git", …) helper.',
    author: 'Ada Lovelace',
    email: 'ada@example.com',
    refs: [
      { kind: 'head', name: 'HEAD' },
      { kind: 'branch', name: 'git-run' },
    ],
  }),
  c({
    sha: 'b1b2c3d4e5f600000000000000000000000000bb',
    subject: 'fix(terminal): keep scrollback alive',
    author: 'Grace Hopper',
    email: 'grace@navy.mil',
    refs: [{ kind: 'branch', name: 'main' }],
  }),
  c({
    sha: 'c1b2c3d4e5f600000000000000000000000000cc',
    subject: 'docs: spec logging + git-history',
    author: 'Ada Lovelace',
    email: 'ada@example.com',
    refs: [{ kind: 'tag', name: 'v0.5.1' }],
  }),
];

describe('matchesQuery', () => {
  it('matches empty/whitespace query against everything', () => {
    expect(matchesQuery(fixture[0], '')).toBe(true);
    expect(matchesQuery(fixture[0], '   ')).toBe(true);
  });

  it('matches a subject substring, case-insensitively', () => {
    expect(fixture.filter((cm) => matchesQuery(cm, 'logging')).map((cm) => cm.sha)).toEqual([
      fixture[0].sha,
      fixture[2].sha,
    ]);
    expect(matchesQuery(fixture[1], 'SCROLLBACK')).toBe(true);
  });

  it('matches author name and email', () => {
    expect(matchesQuery(fixture[1], 'grace')).toBe(true);
    expect(matchesQuery(fixture[1], 'navy.mil')).toBe(true);
    expect(matchesQuery(fixture[1], 'ada')).toBe(false);
  });

  it('matches the body', () => {
    expect(matchesQuery(fixture[0], 'helper')).toBe(true);
  });

  it('matches both the full sha and the short (7-char) sha', () => {
    expect(matchesQuery(fixture[0], fixture[0].sha)).toBe(true);
    expect(matchesQuery(fixture[0], 'a1b2c3d')).toBe(true);
    expect(matchesQuery(fixture[0], 'A1B2C3D')).toBe(true);
    expect(matchesQuery(fixture[0], 'deadbee')).toBe(false);
  });
});

describe('hasRef', () => {
  it('matches an exact ref name on the commit', () => {
    expect(hasRef(fixture[0], 'git-run')).toBe(true);
    expect(hasRef(fixture[1], 'main')).toBe(true);
    expect(hasRef(fixture[0], 'main')).toBe(false);
  });
});

describe('collectRefs', () => {
  it('collects distinct refs, drops the bare HEAD pointer, sorts by kind then name', () => {
    const refs = collectRefs(fixture);
    expect(refs.find((r) => r.kind === 'head')).toBeUndefined();
    expect(refs).toEqual<GitRef[]>([
      { kind: 'branch', name: 'git-run' },
      { kind: 'branch', name: 'main' },
      { kind: 'tag', name: 'v0.5.1' },
    ]);
  });

  it('de-dupes a ref present on multiple commits', () => {
    const dup = [
      c({ sha: 'x', refs: [{ kind: 'branch', name: 'dev' }] }),
      c({ sha: 'y', refs: [{ kind: 'branch', name: 'dev' }] }),
    ];
    expect(collectRefs(dup)).toEqual([{ kind: 'branch', name: 'dev' }]);
  });
});

describe('reachableFromRef', () => {
  // A small topology (newest first, as git --date-order emits): a feature branch off main.
  //   F2 (refs: feature) ─┐
  //   F1 ─────────────────┤
  //   M2 (refs: main) ────┤
  //   M1 (root) ──────────┘
  // feature = [F2, F1, M2, M1] (F1's parent is M2); main = [M2, M1].
  const topo: CommitNode[] = [
    c({ sha: 'F2', parents: ['F1'], refs: [{ kind: 'branch', name: 'feature' }] }),
    c({ sha: 'F1', parents: ['M2'] }),
    c({ sha: 'M2', parents: ['M1'], refs: [{ kind: 'branch', name: 'main' }] }),
    c({ sha: 'M1', parents: [] }),
  ];

  it('walks the parent chain from the ref tip (tip + all ancestors)', () => {
    expect([...reachableFromRef(topo, 'feature')].sort()).toEqual(['F1', 'F2', 'M1', 'M2']);
    expect([...reachableFromRef(topo, 'main')].sort()).toEqual(['M1', 'M2']);
  });

  it('does not include commits unreachable from the ref tip', () => {
    const main = reachableFromRef(topo, 'main');
    expect(main.has('F2')).toBe(false);
    expect(main.has('F1')).toBe(false);
  });

  it('returns an empty set for a ref absent from the loaded commits', () => {
    expect(reachableFromRef(topo, 'no-such-branch').size).toBe(0);
  });

  it('stops at the loaded-page boundary (an ancestor not in the set is not reached)', () => {
    // Only the tip is loaded; its parent M1 isn't in the set, so the walk stops at the tip.
    const partial = [c({ sha: 'M2', parents: ['M1'], refs: [{ kind: 'branch', name: 'main' }] })];
    expect([...reachableFromRef(partial, 'main')]).toEqual(['M2']);
  });
});

describe('filterCommits', () => {
  it('applies query and ref filter together', () => {
    expect(filterCommits(fixture, 'logging', null).map((cm) => cm.sha)).toEqual([
      fixture[0].sha,
      fixture[2].sha,
    ]);
    expect(filterCommits(fixture, '', 'main').map((cm) => cm.sha)).toEqual([fixture[1].sha]);
    // Both active: a "logging" commit on the git-run branch only.
    expect(filterCommits(fixture, 'logging', 'git-run').map((cm) => cm.sha)).toEqual([
      fixture[0].sha,
    ]);
  });

  it('preserves input order so lanes recompute correctly on the subset', () => {
    const out = filterCommits(fixture, '', null);
    expect(out.map((cm) => cm.sha)).toEqual(fixture.map((cm) => cm.sha));
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterCommits(fixture, 'nonexistent-xyz', null)).toEqual([]);
  });
});

describe('isStaleHistory', () => {
  it('drops a superseded response (older id) and keeps the latest', () => {
    expect(isStaleHistory(1, 2)).toBe(true);
    expect(isStaleHistory(2, 2)).toBe(false);
  });

  it('treats an untagged (undefined) response as never stale', () => {
    expect(isStaleHistory(undefined, 5)).toBe(false);
  });
});

describe('visibleRange', () => {
  const ROW = 30;

  it('windows to the on-screen rows plus overscan', () => {
    // scrollTop 300 → first visible row 10; viewport 300px → 10 rows; overscan 2.
    const r = visibleRange(300, 300, ROW, 1000, 2);
    expect(r.start).toBe(8); // 10 - 2 overscan
    expect(r.end).toBe(22); // 10 + 10 visible + 2 overscan
    // The window is far smaller than the total.
    expect(r.end - r.start).toBeLessThan(1000);
  });

  it('clamps to [0, total] at the top and bottom edges', () => {
    expect(visibleRange(0, 300, ROW, 1000, 4).start).toBe(0);
    const bottom = visibleRange(1000 * ROW, 300, ROW, 1000, 4);
    expect(bottom.end).toBe(1000);
  });

  it('returns an empty window for an empty / zero-height list', () => {
    expect(visibleRange(0, 300, ROW, 0, 4)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(0, 300, 0, 100, 4)).toEqual({ start: 0, end: 0 });
  });

  it('renders a head window even before the viewport is measured (height 0)', () => {
    const r = visibleRange(0, 0, ROW, 100, 6);
    expect(r.start).toBe(0);
    expect(r.end).toBeGreaterThanOrEqual(1);
  });
});
