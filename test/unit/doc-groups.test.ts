import { describe, expect, it } from 'vitest';
import {
  dirtyPreviewTabs,
  groupDocs,
  openTargetGroup,
  resolveActivateGroup,
  splitBehavior,
  tabPreview,
} from '../../webview/doc-groups';
import type { DocsState, OpenDoc } from '../../webview/docs';

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
