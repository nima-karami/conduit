import { describe, expect, it } from 'vitest';
import type { PersistedDoc } from '../../src/protocol';
import {
  activeGroupOf,
  centerLayout,
  dirtyPreviewTabs,
  type GroupIndex,
  groupActive,
  groupDocs,
  openTargetGroup,
  previewIdsOf,
  resolveActivateGroup,
  splitBehavior,
  tabGroupsOf,
  tabPreview,
} from '../../webview/doc-groups';
import {
  backgroundOpenOutcome,
  type DocsAction,
  type DocsState,
  docsReducer,
  initialDocs,
  type OpenDoc,
  type OpenMode,
  toPersistedDocs,
} from '../../webview/docs';

const doc = (kind: OpenDoc['kind'], path: string, sessionId = 'S1'): OpenDoc => ({
  id: `${kind}:${path}`,
  kind,
  path,
  title: path,
  sessionId,
});

describe('doc-groups selectors', () => {
  const a = doc('file', '/a.ts');
  const b = doc('file', '/b.ts');
  const c = doc('diff', '/c.ts');

  it('groupDocs returns registry docs by reference in tab order', () => {
    const s: DocsState = {
      docs: [a, b, c],
      layouts: {
        S1: {
          groups: [
            { tabs: [{ id: c.id }, { id: a.id }], active: a.id },
            { tabs: [{ id: b.id }], active: b.id },
          ],
          activeGroup: 1,
        },
      },
      activeId: a.id,
    };
    const g1 = groupDocs(s, 'S1', 1);
    expect(g1).toHaveLength(2);
    expect(g1[0]).toBe(c);
    expect(g1[1]).toBe(a);
    expect(groupDocs(s, 'S1', 2)[0]).toBe(b);
    expect(groupDocs(s, 'S2', 1)).toEqual([]);
  });

  it('tabPreview reads the tab, independently per group', () => {
    const s: DocsState = {
      docs: [a],
      layouts: {
        S1: {
          groups: [
            { tabs: [{ id: a.id }], active: a.id },
            { tabs: [{ id: a.id, preview: true }], active: a.id },
          ],
          activeGroup: 2,
        },
      },
      activeId: a.id,
    };
    expect(tabPreview(s, 'S1', 1, a.id)).toBe(false);
    expect(tabPreview(s, 'S1', 2, a.id)).toBe(true);
  });

  it('openTargetGroup is 2 while group 1 shows the Terminal and group 2 exists', () => {
    const two = (g1Active: string | null, activeGroup: 1 | 2): DocsState => ({
      docs: [a, b],
      layouts: {
        S1: {
          groups: [
            { tabs: [{ id: a.id }], active: g1Active },
            { tabs: [{ id: b.id }], active: b.id },
          ],
          activeGroup,
        },
      },
      activeId: null,
    });
    expect(openTargetGroup(two(null, 1), 'S1')).toBe(2);
    expect(openTargetGroup(two(a.id, 1), 'S1')).toBe(1);
    expect(openTargetGroup(two(a.id, 2), 'S1')).toBe(2);
    const one: DocsState = {
      docs: [a],
      layouts: { S1: { groups: [{ tabs: [{ id: a.id }], active: null }], activeGroup: 1 } },
      activeId: null,
    };
    expect(openTargetGroup(one, 'S1')).toBe(1);
    expect(openTargetGroup(one, 'nobody')).toBe(1);
  });

  it('resolveActivateGroup prefers the active group when both hold the doc', () => {
    const s = (activeGroup: 1 | 2): DocsState => ({
      docs: [a, b],
      layouts: {
        S1: {
          groups: [
            { tabs: [{ id: a.id }], active: a.id },
            { tabs: [{ id: a.id }, { id: b.id }], active: b.id },
          ],
          activeGroup,
        },
      },
      activeId: null,
    });
    expect(resolveActivateGroup(s(2), 'S1', a.id)).toBe(2);
    expect(resolveActivateGroup(s(1), 'S1', a.id)).toBe(1);
    expect(resolveActivateGroup(s(1), 'S1', b.id)).toBe(2);
    expect(resolveActivateGroup(s(2), 'S1', 'file:/nowhere')).toBe(2);
    expect(resolveActivateGroup(s(2), 'S1', null)).toBe(1);
  });

  it('splitBehavior moves web, review and git-history', () => {
    expect(splitBehavior('web')).toBe('move');
    expect(splitBehavior('review')).toBe('move');
    expect(splitBehavior('git-history')).toBe('move');
    expect(splitBehavior('file')).toBe('duplicate');
    expect(splitBehavior('diff')).toBe('duplicate');
    expect(splitBehavior('commit-diff')).toBe('duplicate');
  });

  it('dirtyPreviewTabs lists every preview tab of a dirty path in both groups and every session', () => {
    const x = doc('file', '/x.ts');
    const xd = doc('diff', '/x.ts');
    const y = doc('file', '/y.ts', 'S2');
    const clean = doc('file', '/clean.ts');
    const s: DocsState = {
      docs: [x, xd, y, clean],
      layouts: {
        S1: {
          groups: [
            {
              tabs: [
                { id: x.id, preview: true },
                { id: clean.id, preview: true },
              ],
              active: x.id,
            },
            { tabs: [{ id: xd.id, preview: true }, { id: x.id }], active: x.id },
          ],
          activeGroup: 1,
        },
        S2: { groups: [{ tabs: [{ id: y.id, preview: true }], active: y.id }], activeGroup: 1 },
      },
      activeId: x.id,
    };
    expect(dirtyPreviewTabs(s, new Set(['/x.ts', '/y.ts']))).toEqual([
      { id: x.id, group: 1 },
      { id: xd.id, group: 2 },
      { id: y.id, group: 1 },
    ]);
  });
});

const SHA = 'c'.repeat(40);
const ids = (s: DocsState, g: GroupIndex, sid = 'S1') => groupDocs(s, sid, g).map((d) => d.id);
const open = (
  s: DocsState,
  path: string,
  o: {
    mode?: OpenMode;
    group?: GroupIndex;
    sessionId?: string;
    kind?: 'file' | 'diff' | 'web';
  } = {},
) =>
  docsReducer(s, {
    type: 'open',
    kind: o.kind ?? 'file',
    path,
    sessionId: o.sessionId ?? 'S1',
    mode: o.mode,
    group: o.group,
  });
const split = (s: DocsState, sessionId = 'S1') => docsReducer(s, { type: 'splitRight', sessionId });
const run = (s: DocsState, ...actions: DocsAction[]) => actions.reduce(docsReducer, s);

describe.each([1, 2] as const)('split-mode core behaviours in group %i', (g) => {
  const other: GroupIndex = g === 1 ? 2 : 1;
  const base = () => split(open(initialDocs, '/base.ts'));

  it("preview open retargets this group's preview in place (same index)", () => {
    let s = open(base(), '/p1.ts', { mode: 'preview', group: g });
    s = open(s, '/mid.ts', { mode: 'permanent', group: g });
    s = open(s, '/p2.ts', { mode: 'preview', group: g });
    expect(ids(s, g)).toEqual(['file:/base.ts', 'file:/p2.ts', 'file:/mid.ts']);
    expect(tabPreview(s, 'S1', g, 'file:/p2.ts')).toBe(true);
    expect(s.docs.some((d) => d.id === 'file:/p1.ts')).toBe(false);
  });

  it('≤1 preview per group', () => {
    let s = base();
    for (const p of ['/a.ts', '/b.ts', '/c.ts']) {
      s = open(s, p, { mode: 'preview', group: g });
      expect(previewIdsOf(s, 'S1', g).size).toBe(1);
    }
    expect(ids(s, g)).toEqual(['file:/base.ts', 'file:/c.ts']);
  });

  it('re-open activates the existing tab', () => {
    let s = open(base(), '/a.ts', { group: g });
    s = open(s, '/b.ts', { group: g });
    s = open(s, '/a.ts', { group: g });
    expect(ids(s, g)).toEqual(['file:/base.ts', 'file:/a.ts', 'file:/b.ts']);
    expect(groupActive(s, 'S1', g)).toBe('file:/a.ts');
    expect(s.activeId).toBe('file:/a.ts');
    expect(s.layouts.S1.activeGroup).toBe(g);
  });

  it('permanent open promotes the preview', () => {
    let s = open(base(), '/a.ts', { mode: 'preview', group: g });
    s = open(s, '/a.ts', { mode: 'permanent', group: g });
    expect(ids(s, g)).toEqual(['file:/base.ts', 'file:/a.ts']);
    expect(tabPreview(s, 'S1', g, 'file:/a.ts')).toBe(false);
  });

  it('close falls back left, then right', () => {
    let s = open(base(), '/a.ts', { group: g });
    s = open(s, '/b.ts', { group: g });
    s = run(
      s,
      { type: 'activate', id: 'file:/a.ts', group: g },
      { type: 'close', id: 'file:/a.ts', group: g },
    );
    expect(groupActive(s, 'S1', g)).toBe('file:/base.ts');
    s = docsReducer(s, { type: 'close', id: 'file:/base.ts', group: g });
    expect(groupActive(s, 'S1', g)).toBe('file:/b.ts');
    expect(ids(s, other)).toContain('file:/base.ts');
  });

  it('reorder promotes a dragged preview', () => {
    let s = open(base(), '/a.ts', { group: g });
    s = open(s, '/p.ts', { mode: 'preview', group: g });
    s = docsReducer(s, { type: 'reorder', dragId: 'file:/p.ts', targetId: 'file:/a.ts', group: g });
    expect(ids(s, g)).toEqual(['file:/base.ts', 'file:/p.ts', 'file:/a.ts']);
    expect(tabPreview(s, 'S1', g, 'file:/p.ts')).toBe(false);
  });

  it("pinDoc clears only this group's preview", () => {
    let s = open(base(), '/p.ts', { mode: 'preview', group: 1 });
    s = open(s, '/p.ts', { mode: 'preview', group: 2 });
    s = docsReducer(s, { type: 'pinDoc', id: 'file:/p.ts', group: g });
    expect(tabPreview(s, 'S1', g, 'file:/p.ts')).toBe(false);
    expect(tabPreview(s, 'S1', other, 'file:/p.ts')).toBe(true);
  });

  it('background open never changes activeId or activeGroup', () => {
    const prev = open(base(), '/a.ts', { group: other });
    const next = open(prev, '/n.ts', { mode: 'background', group: g });
    expect(ids(next, g)).toContain('file:/n.ts');
    expect(next.activeId).toBe(prev.activeId);
    expect(next.layouts.S1.activeGroup).toBe(prev.layouts.S1.activeGroup);
  });
});

describe('group invariants', () => {
  it('I1: every tab id names a doc owned by the layout session', () => {
    const steps: DocsAction[] = [
      { type: 'open', kind: 'file', path: '/a.ts', sessionId: 'A' },
      { type: 'splitRight', sessionId: 'A' },
      { type: 'open', kind: 'file', path: '/b.ts', sessionId: 'A', mode: 'preview' },
      { type: 'open', kind: 'web', path: 'https://x.test/', sessionId: 'A' },
      { type: 'open', kind: 'file', path: '/a.ts', sessionId: 'B' },
      { type: 'openCommitFile', sha: SHA, file: 'x.ts', sessionId: 'B', mode: 'preview' },
      { type: 'splitRight', sessionId: 'B' },
      { type: 'openReview', sessionId: 'A', source: { kind: 'working' } },
      { type: 'moveTab', sessionId: 'A', id: 'review:@review', toGroup: 1 },
      { type: 'open', kind: 'web', path: 'https://x.test/', sessionId: 'B', mode: 'background' },
      { type: 'openReview', sessionId: 'B', source: { kind: 'working' } },
      { type: 'close', id: 'file:/b.ts' },
      { type: 'closeSession', sessionId: 'A' },
    ];
    let s = initialDocs;
    for (const step of steps) {
      s = docsReducer(s, step);
      for (const [sid, layout] of Object.entries(s.layouts)) {
        for (const group of layout.groups) {
          for (const t of group.tabs) {
            expect(s.docs.find((d) => d.id === t.id)?.sessionId, `${step.type}: ${t.id}`).toBe(sid);
          }
        }
      }
    }
  });

  it('I2: splitRight on a web tab moves it; groupDocs(1) no longer holds it', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, 'https://x.test/', { kind: 'web' });
    s = split(s);
    expect(ids(s, 1)).toEqual(['file:/a.ts']);
    expect(ids(s, 2)).toEqual(['web:https://x.test/']);
  });

  it("I3: a preview open in group 2 leaves group 1's preview alone", () => {
    let s = split(open(initialDocs, '/base.ts'));
    s = open(s, '/a.ts', { mode: 'preview', group: 1 });
    s = open(s, '/b.ts', { mode: 'preview', group: 2 });
    expect([...previewIdsOf(s, 'S1', 1)]).toEqual(['file:/a.ts']);
    expect([...previewIdsOf(s, 'S1', 2)]).toEqual(['file:/b.ts']);
  });

  it("I4: closing the last group-2 tab removes group 2, and activeId is group 1's active", () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/b.ts');
    s = split(s);
    s = docsReducer(s, { type: 'close', id: 'file:/b.ts', group: 2 });
    expect(s.layouts.S1.groups).toHaveLength(1);
    expect(s.layouts.S1.activeGroup).toBe(1);
    expect(s.activeId).toBe('file:/b.ts');
  });

  it('I5: splitRight with the Terminal active returns the same state object', () => {
    const s = docsReducer(open(initialDocs, '/a.ts'), {
      type: 'activate',
      id: null,
      sessionId: 'S1',
    });
    expect(split(s)).toBe(s);
  });

  it('I6: closing the only tab of a group-2-only doc removes the doc from docs', () => {
    let s = split(open(initialDocs, '/a.ts'));
    s = open(s, '/c.ts', { group: 2 });
    s = docsReducer(s, { type: 'close', id: 'file:/c.ts', group: 2 });
    expect(s.docs.map((d) => d.id)).toEqual(['file:/a.ts']);
  });

  it("I8: retargeting group 1's preview keeps the doc group 2 still shows", () => {
    let s = open(initialDocs, '/p.ts', { mode: 'preview' });
    s = split(s);
    s = docsReducer(s, { type: 'focusGroup', sessionId: 'S1', group: 1 });
    s = open(s, '/q.ts', { mode: 'preview', group: 1 });
    expect(ids(s, 1)).toEqual(['file:/q.ts']);
    expect(ids(s, 2)).toEqual(['file:/p.ts']);
    expect(s.docs.some((d) => d.id === 'file:/p.ts')).toBe(true);
  });

  it("I9: a foreground open from B of A's only group-2 doc collapses A's group 2", () => {
    let s = open(initialDocs, '/a.ts', { sessionId: 'A' });
    s = open(s, 'https://x.test/', { kind: 'web', sessionId: 'A' });
    s = split(s, 'A');
    expect(ids(s, 2, 'A')).toEqual(['web:https://x.test/']);
    s = open(s, 'https://x.test/', { kind: 'web', sessionId: 'B' });
    expect(s.layouts.A.groups).toHaveLength(1);
    expect(s.layouts.A.activeGroup).toBe(1);
    expect(ids(s, 1, 'B')).toEqual(['web:https://x.test/']);
  });
});

describe('group actions', () => {
  it('splitRight duplicates a file into group 2 and focuses it', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/b.ts');
    s = split(s);
    expect(s.activeId).toBe('file:/b.ts');
    expect(s.layouts.S1.activeGroup).toBe(2);
    expect(ids(s, 1)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(ids(s, 2)).toEqual(['file:/b.ts']);
  });

  it('splitRight on a preview pins the group-2 tab; group 1 stays preview', () => {
    const s = split(open(initialDocs, '/p.ts', { mode: 'preview' }));
    expect(tabPreview(s, 'S1', 2, 'file:/p.ts')).toBe(false);
    expect(tabPreview(s, 'S1', 1, 'file:/p.ts')).toBe(true);
  });

  it('splitRight on the commit-diff @preview re-keys to the pinned id first', () => {
    let s = docsReducer(initialDocs, {
      type: 'openCommitFile',
      sha: SHA,
      file: 'x.ts',
      sessionId: 'S1',
      mode: 'preview',
    });
    s = split(s);
    const pinned = `commit-diff:${SHA} x.ts`;
    expect(ids(s, 1)).toEqual([pinned]);
    expect(ids(s, 2)).toEqual([pinned]);
    expect(s.docs.map((d) => d.id)).toEqual([pinned]);
    expect(s.activeId).toBe(pinned);
  });

  it('splitRight with group 2 active returns the same state', () => {
    const s = split(open(initialDocs, '/a.ts'));
    expect(split(s)).toBe(s);
  });

  it('moveTab into group 1 inserts before beforeId, pinned', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/b.ts');
    s = split(s);
    s = open(s, '/c.ts', { mode: 'preview', group: 2 });
    s = docsReducer(s, {
      type: 'moveTab',
      sessionId: 'S1',
      id: 'file:/c.ts',
      toGroup: 1,
      beforeId: 'file:/b.ts',
    });
    expect(ids(s, 1)).toEqual(['file:/a.ts', 'file:/c.ts', 'file:/b.ts']);
    expect(tabPreview(s, 'S1', 1, 'file:/c.ts')).toBe(false);
    expect(ids(s, 2)).toEqual(['file:/b.ts']);
    expect(s.layouts.S1.activeGroup).toBe(1);
    expect(s.activeId).toBe('file:/c.ts');
  });

  it('moveTab duplicate leaves the source tab', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/b.ts');
    s = split(s);
    s = docsReducer(s, { type: 'activate', id: 'file:/a.ts', sessionId: 'S1', group: 1 });
    s = docsReducer(s, {
      type: 'moveTab',
      sessionId: 'S1',
      id: 'file:/a.ts',
      toGroup: 2,
      beforeId: 'file:/b.ts',
      duplicate: true,
    });
    expect(ids(s, 1)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(groupActive(s, 'S1', 1)).toBe('file:/a.ts');
    expect(ids(s, 2)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(s.layouts.S1.activeGroup).toBe(2);
    expect(s.activeId).toBe('file:/a.ts');

    s = docsReducer(s, {
      type: 'moveTab',
      sessionId: 'S1',
      id: 'file:/b.ts',
      toGroup: 1,
      duplicate: true,
    });
    expect(ids(s, 1)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(ids(s, 2)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(s.layouts.S1.activeGroup).toBe(1);
    expect(s.activeId).toBe('file:/b.ts');
  });

  it('moveTab duplicate of a move-only kind still moves it', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, 'https://example.com/', { kind: 'web' });
    s = docsReducer(s, {
      type: 'moveTab',
      sessionId: 'S1',
      id: 'web:https://example.com/',
      toGroup: 2,
      duplicate: true,
    });
    expect(ids(s, 1)).toEqual(['file:/a.ts']);
    expect(ids(s, 2)).toEqual(['web:https://example.com/']);
  });

  it('moveTab to group 2 with one group creates it', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/b.ts', { mode: 'preview' });
    expect(docsReducer(s, { type: 'moveTab', sessionId: 'S1', id: 'file:/b.ts', toGroup: 1 })).toBe(
      s,
    );
    const moved = docsReducer(s, {
      type: 'moveTab',
      sessionId: 'S1',
      id: 'file:/b.ts',
      toGroup: 2,
    });
    expect(ids(moved, 1)).toEqual(['file:/a.ts']);
    expect(groupActive(moved, 'S1', 1)).toBe('file:/a.ts');
    expect(ids(moved, 2)).toEqual(['file:/b.ts']);
    expect(tabPreview(moved, 'S1', 2, 'file:/b.ts')).toBe(false);
    expect(moved.layouts.S1.activeGroup).toBe(2);
    expect(moved.activeId).toBe('file:/b.ts');

    const duplicated = docsReducer(s, {
      type: 'moveTab',
      sessionId: 'S1',
      id: 'file:/b.ts',
      toGroup: 2,
      duplicate: true,
    });
    expect(ids(duplicated, 1)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(tabPreview(duplicated, 'S1', 1, 'file:/b.ts')).toBe(true);
    expect(ids(duplicated, 2)).toEqual(['file:/b.ts']);
    expect(duplicated.activeId).toBe('file:/b.ts');
  });

  it('joinGroups appends group-2-only tabs to group 1, drops duplicates, removes group 2', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/b.ts');
    s = split(s);
    s = open(s, '/c.ts', { group: 2 });
    s = open(s, '/d.ts', { mode: 'preview', group: 2 });
    expect(ids(s, 2)).toEqual(['file:/b.ts', 'file:/c.ts', 'file:/d.ts']);
    const single = open(initialDocs, '/a.ts');
    expect(docsReducer(single, { type: 'joinGroups', sessionId: 'S1' })).toBe(single);

    const joined = docsReducer(s, { type: 'joinGroups', sessionId: 'S1' });
    expect(joined.layouts.S1.groups).toHaveLength(1);
    expect(joined.layouts.S1.activeGroup).toBe(1);
    expect(ids(joined, 1)).toEqual(['file:/a.ts', 'file:/b.ts', 'file:/c.ts', 'file:/d.ts']);
    expect(tabPreview(joined, 'S1', 1, 'file:/d.ts')).toBe(false);
    expect(groupActive(joined, 'S1', 1)).toBe('file:/d.ts');
    expect(joined.activeId).toBe('file:/d.ts');

    const fromG1 = run(
      s,
      { type: 'focusGroup', sessionId: 'S1', group: 1 },
      { type: 'joinGroups', sessionId: 'S1' },
    );
    expect(ids(fromG1, 1)).toEqual(['file:/a.ts', 'file:/b.ts', 'file:/c.ts', 'file:/d.ts']);
    expect(groupActive(fromG1, 'S1', 1)).toBe('file:/b.ts');
    expect(fromG1.activeId).toBe('file:/b.ts');
  });

  it('focusGroup swaps activeId', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/b.ts');
    s = split(s);
    s = open(s, '/c.ts', { group: 2 });
    s = docsReducer(s, { type: 'focusGroup', sessionId: 'S1', group: 1 });
    expect(s.activeId).toBe('file:/b.ts');
    s = docsReducer(s, { type: 'focusGroup', sessionId: 'S1', group: 2 });
    expect(s.activeId).toBe('file:/c.ts');
    expect(docsReducer(s, { type: 'focusGroup', sessionId: 'S1', group: 2 })).toBe(s);
  });

  it('close {group} closes one tab of two and keeps the doc', () => {
    let s = split(open(initialDocs, '/a.ts'));
    s = open(s, '/b.ts', { group: 1 });
    s = docsReducer(s, { type: 'close', id: 'file:/a.ts', group: 1 });
    expect(ids(s, 1)).toEqual(['file:/b.ts']);
    expect(ids(s, 2)).toEqual(['file:/a.ts']);
    expect(s.docs.some((d) => d.id === 'file:/a.ts')).toBe(true);
  });

  it('a commit-diff preview and a file preview never replace each other', () => {
    const commitPreview: DocsAction = {
      type: 'openCommitFile',
      sha: SHA,
      file: 'x.ts',
      sessionId: 'S1',
      mode: 'preview',
    };
    const fileFirst = run(open(initialDocs, '/p.ts', { mode: 'preview' }), commitPreview);
    expect(ids(fileFirst, 1)).toEqual(['file:/p.ts', 'commit-diff:@preview']);
    expect(tabPreview(fileFirst, 'S1', 1, 'file:/p.ts')).toBe(true);
    expect(tabPreview(fileFirst, 'S1', 1, 'commit-diff:@preview')).toBe(true);

    const commitFirst = open(run(initialDocs, commitPreview), '/p.ts', { mode: 'preview' });
    expect(ids(commitFirst, 1)).toEqual(['commit-diff:@preview', 'file:/p.ts']);
  });

  it("an ownership transfer appends a pinned tab and keeps the new owner's preview", () => {
    let s = open(initialDocs, '/a.ts', { sessionId: 'A' });
    s = open(s, '/q.ts', { mode: 'preview', sessionId: 'B' });
    s = open(s, '/a.ts', { mode: 'preview', sessionId: 'B' });
    expect(ids(s, 1, 'B')).toEqual(['file:/q.ts', 'file:/a.ts']);
    expect(tabPreview(s, 'B', 1, 'file:/a.ts')).toBe(false);
    expect(tabPreview(s, 'B', 1, 'file:/q.ts')).toBe(true);
    expect(s.docs.find((d) => d.id === 'file:/a.ts')?.sessionId).toBe('B');

    let r = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'A',
      source: { kind: 'working' },
    });
    r = open(r, '/q.ts', { mode: 'preview', sessionId: 'B' });
    r = docsReducer(r, { type: 'openReview', sessionId: 'B', source: { kind: 'working' } });
    expect(ids(r, 1, 'B')).toEqual(['file:/q.ts', 'review:@review']);
    expect(tabPreview(r, 'B', 1, 'review:@review')).toBe(false);
    expect(tabPreview(r, 'B', 1, 'file:/q.ts')).toBe(true);

    const slotFrom = (sessionId: string): DocsAction => ({
      type: 'openCommitFile',
      sha: SHA,
      file: `${sessionId}.ts`,
      sessionId,
      mode: 'preview',
    });
    const c = run(initialDocs, slotFrom('A'), slotFrom('B'));
    expect(ids(c, 1, 'B')).toEqual(['commit-diff:@preview']);
    expect(tabPreview(c, 'B', 1, 'commit-diff:@preview')).toBe(true);
  });

  it('switchSession restores group 2 as active', () => {
    let s = split(open(initialDocs, '/a.ts'));
    s = open(s, '/c.ts', { group: 2 });
    s = docsReducer(s, { type: 'switchSession', sessionId: 'S2' });
    expect(s.activeId).toBeNull();
    s = docsReducer(s, { type: 'switchSession', sessionId: 'S1' });
    expect(s.activeId).toBe('file:/c.ts');
    expect(s.layouts.S1.activeGroup).toBe(2);
  });

  it("closeSession falls back to the last remaining doc's session active", () => {
    let s = open(initialDocs, '/a.ts', { sessionId: 'A' });
    s = open(s, '/a2.ts', { sessionId: 'A' });
    s = docsReducer(s, { type: 'activate', id: 'file:/a.ts', sessionId: 'A' });
    s = open(s, '/b.ts', { sessionId: 'B' });
    s = docsReducer(s, { type: 'closeSession', sessionId: 'B' });
    expect(s.activeId).toBe('file:/a.ts');
  });
});

describe('group persistence', () => {
  it('toPersistedDocs: group 1 then group:2 entries, per-tab preview and active', () => {
    let s = open(initialDocs, '/a.ts');
    s = open(s, '/p.ts', { mode: 'preview' });
    s = split(s);
    s = open(s, '/q.ts', { mode: 'preview', group: 2 });
    expect(toPersistedDocs(s)).toEqual([
      { kind: 'file', path: '/a.ts', sessionId: 'S1' },
      { kind: 'file', path: '/p.ts', sessionId: 'S1', preview: true, active: true },
      { kind: 'file', path: '/p.ts', sessionId: 'S1', group: 2 },
      { kind: 'file', path: '/q.ts', sessionId: 'S1', preview: true, active: true, group: 2 },
    ]);
  });

  it('restore rebuilds both groups; dedupe per (id, group); activeGroup 1; activeId null', () => {
    const docs: PersistedDoc[] = [
      { kind: 'file', path: '/a.ts', sessionId: 'S1' },
      { kind: 'file', path: '/p.ts', sessionId: 'S1', preview: true, active: true },
      { kind: 'file', path: '/p.ts', sessionId: 'S1', group: 2 },
      { kind: 'file', path: '/p.ts', sessionId: 'S1', preview: true, group: 2 },
      { kind: 'file', path: '/q.ts', sessionId: 'S1', preview: true, active: true, group: 2 },
    ];
    const s = docsReducer(initialDocs, { type: 'restore', docs, knownSessionIds: ['S1'] });
    expect(ids(s, 1)).toEqual(['file:/a.ts', 'file:/p.ts']);
    expect(ids(s, 2)).toEqual(['file:/p.ts', 'file:/q.ts']);
    expect(tabPreview(s, 'S1', 1, 'file:/p.ts')).toBe(true);
    expect(tabPreview(s, 'S1', 2, 'file:/p.ts')).toBe(false);
    expect(groupActive(s, 'S1', 1)).toBe('file:/p.ts');
    expect(groupActive(s, 'S1', 2)).toBe('file:/q.ts');
    expect(s.layouts.S1.activeGroup).toBe(1);
    expect(s.activeId).toBeNull();
    expect(s.docs).toHaveLength(3);
    expect(toPersistedDocs(s)).toEqual(docs.filter((_, i) => i !== 3));
  });

  // The literals are the pre-change reducer's output for docs.test.ts's fixtures.
  it('single-session toPersistedDocs is byte-identical', () => {
    const A40 = 'a'.repeat(40);
    const permanentThenPreview = run(
      initialDocs,
      { type: 'open', kind: 'file', path: '/a.ts', sessionId: 'S1', mode: 'permanent' },
      { type: 'open', kind: 'file', path: '/b.ts', sessionId: 'S1', mode: 'preview' },
    );
    const scoped = run(
      initialDocs,
      { type: 'open', kind: 'diff', path: '/r/a.ts', sessionId: 'S1', diffScope: 'unstaged' },
      { type: 'open', kind: 'diff', path: '/r/a.ts', sessionId: 'S1' },
      { type: 'open', kind: 'diff', path: '/r/a.ts', sessionId: 'S1', diffScope: 'staged' },
    );
    const everyKind = run(
      initialDocs,
      { type: 'open', kind: 'file', path: '/a.ts', sessionId: 'S1' },
      { type: 'open', kind: 'diff', path: '/a.ts', sessionId: 'S1' },
      { type: 'open', kind: 'web', path: 'https://example.com/foo', sessionId: 'S1' },
      { type: 'openReview', sessionId: 'S1', source: { kind: 'working' } },
      { type: 'open', kind: 'git-history', path: '@git-history', sessionId: 'S1' },
      { type: 'openCommitFile', sha: A40, file: 'src/a.ts', sessionId: 'S1', mode: 'permanent' },
    );
    const slot = run(initialDocs, {
      type: 'openCommitFile',
      sha: A40,
      file: 'src/a.ts',
      sessionId: 'S1',
      mode: 'preview',
    });
    expect(JSON.stringify(toPersistedDocs(permanentThenPreview))).toBe(
      '[{"kind":"file","path":"/a.ts","sessionId":"S1"},{"kind":"file","path":"/b.ts","sessionId":"S1","preview":true,"active":true}]',
    );
    expect(JSON.stringify(toPersistedDocs(scoped))).toBe(
      '[{"kind":"diff","path":"/r/a.ts","sessionId":"S1","diffScope":"unstaged"},{"kind":"diff","path":"/r/a.ts","sessionId":"S1"},{"kind":"diff","path":"/r/a.ts","sessionId":"S1","diffScope":"staged","active":true}]',
    );
    expect(JSON.stringify(toPersistedDocs(everyKind))).toBe(
      '[{"kind":"file","path":"/a.ts","sessionId":"S1"},{"kind":"diff","path":"/a.ts","sessionId":"S1"},{"kind":"web","path":"https://example.com/foo","sessionId":"S1"},{"kind":"review","path":"@review","sessionId":"S1"},{"kind":"git-history","path":"@git-history","sessionId":"S1"},{"kind":"commit-diff","path":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa src/a.ts","sessionId":"S1","active":true}]',
    );
    expect(JSON.stringify(toPersistedDocs(slot))).toBe(
      '[{"kind":"commit-diff","path":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa src/a.ts","sessionId":"S1","preview":true,"active":true}]',
    );
  });
});

describe('group background outcome', () => {
  it('backgroundOpenOutcome is opened for a file only in the other group', () => {
    let s = split(open(initialDocs, '/a.ts'));
    s = open(s, '/c.ts', { group: 2 });
    s = docsReducer(s, { type: 'focusGroup', sessionId: 'S1', group: 1 });
    expect(backgroundOpenOutcome(s, 'file', '/c.ts', 'S1')).toEqual({
      outcome: 'opened',
      ownerSessionId: 'S1',
      id: 'file:/c.ts',
      title: 'c.ts',
    });
    expect(backgroundOpenOutcome(s, 'file', '/a.ts', 'S1').outcome).toBe('already-open');
    const next = open(s, '/c.ts', { mode: 'background' });
    expect(ids(next, 1)).toEqual(['file:/a.ts', 'file:/c.ts']);
  });
});

describe('group selectors for app consumers', () => {
  it('tabGroupsOf lists both groups for a duplicated doc', () => {
    let s = split(open(initialDocs, '/a.ts'));
    s = open(s, '/b.ts', { group: 1 });
    expect(tabGroupsOf(s, 'file:/a.ts')).toEqual([1, 2]);
    expect(tabGroupsOf(s, 'file:/b.ts')).toEqual([1]);
    expect(tabGroupsOf(s, 'file:/nowhere')).toEqual([]);
  });

  it('activeGroupOf defaults to 1', () => {
    expect(activeGroupOf(initialDocs, 'S1')).toBe(1);
    const s = split(open(initialDocs, '/a.ts'));
    expect(activeGroupOf(s, 'S1')).toBe(2);
    expect(activeGroupOf(s, 'S2')).toBe(1);
  });

  it('edit-promotes per tab (P8)', () => {
    let s = open(initialDocs, '/x.ts', { mode: 'permanent', group: 1 });
    s = split(open(s, '/o.ts', { mode: 'permanent', group: 1 }));
    s = open(s, '/x.ts', { mode: 'preview', group: 2 });
    expect(tabPreview(s, 'S1', 2, 'file:/x.ts')).toBe(true);
    const g1Before = s.layouts.S1.groups[0];
    for (const t of dirtyPreviewTabs(s, new Set(['/x.ts']))) {
      s = docsReducer(s, { type: 'pinDoc', id: t.id, group: t.group });
    }
    expect(tabPreview(s, 'S1', 2, 'file:/x.ts')).toBe(false);
    expect(s.layouts.S1.groups[0]).toEqual(g1Before);
  });
});

describe('centerLayout', () => {
  it('is one empty group for no session', () => {
    const l = centerLayout(initialDocs, undefined);
    expect(l.activeGroup).toBe(1);
    expect(l.groups).toHaveLength(1);
    expect(l.groups[0]).toMatchObject({ group: 1, docs: [], activeDocId: null });
    expect(l.groups[0].previewIds.size).toBe(0);
  });

  it('gives each group its docs, active tab and preview ids', () => {
    let s = open(initialDocs, '/a.ts', { mode: 'permanent' });
    s = split(s);
    s = open(s, '/b.ts', { mode: 'preview', group: 2 });
    const l = centerLayout(s, 'S1');
    expect(l.activeGroup).toBe(2);
    expect(l.groups.map((v) => v.group)).toEqual([1, 2]);
    expect(l.groups[0].docs.map((d) => d.id)).toEqual(['file:/a.ts']);
    expect(l.groups[0].activeDocId).toBe('file:/a.ts');
    expect(l.groups[1].docs.map((d) => d.id)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(l.groups[1].activeDocId).toBe('file:/b.ts');
    expect([...l.groups[1].previewIds]).toEqual(['file:/b.ts']);
    expect(l.groups[0].previewIds.size).toBe(0);
  });
});

describe('group moveFiles', () => {
  const k = doc('file', '/w/k.ts');
  const a = doc('file', '/w/a.ts');
  const z = doc('file', '/w/z.ts');
  const split: DocsState = {
    docs: [k, a, z],
    layouts: {
      S1: {
        groups: [
          { tabs: [{ id: k.id }, { id: a.id, preview: true }], active: a.id },
          { tabs: [{ id: a.id }, { id: z.id }], active: a.id },
        ],
        activeGroup: 2,
      },
    },
    activeId: a.id,
  };
  const move = (s: DocsState, from: string, to: string) =>
    docsReducer(s, { type: 'moveFiles', moves: [{ from, to }] });

  it('moveFiles retargets the tab in both groups', () => {
    const r = move(split, '/w/a.ts', '/w/b.ts');
    expect(r.layouts.S1.groups).toEqual([
      {
        tabs: [{ id: 'file:/w/k.ts' }, { id: 'file:/w/b.ts', preview: true }],
        active: 'file:/w/b.ts',
      },
      { tabs: [{ id: 'file:/w/b.ts' }, { id: 'file:/w/z.ts' }], active: 'file:/w/b.ts' },
    ]);
    expect(r.layouts.S1.activeGroup).toBe(2);
    expect(r.activeId).toBe('file:/w/b.ts');
    expect(r.docs.find((d) => d.id === 'file:/w/b.ts')).toMatchObject({
      path: '/w/b.ts',
      title: 'b.ts',
      sessionId: 'S1',
    });
    expect(r.docs.some((d) => d.id === 'file:/w/a.ts')).toBe(false);
  });

  it('a group that is not showing the moved tab keeps its own active tab', () => {
    const s = docsReducer(split, { type: 'activate', id: z.id, sessionId: 'S1', group: 2 });
    const r = move(s, '/w/a.ts', '/w/b.ts');
    expect(groupActive(r, 'S1', 1)).toBe('file:/w/b.ts');
    expect(groupActive(r, 'S1', 2)).toBe('file:/w/z.ts');
    expect(r.activeId).toBe('file:/w/z.ts');
  });
});
