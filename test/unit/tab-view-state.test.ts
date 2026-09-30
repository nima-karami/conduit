import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('monaco-editor', async () => {
  const { URI } = await import('monaco-editor/esm/vs/base/common/uri.js');
  return { Uri: URI, editor: { getModel: () => null } };
});

import type { OpenDoc } from '../../webview/docs';
import { clearHtmlView, getHtmlScroll, setHtmlScroll } from '../../webview/html-view-store';
import { clearReveal, hasReveal, peekReveal, setReveal } from '../../webview/project-index';
import {
  carryTabState,
  dropTabState,
  pinTabStateForMove,
  tabViewStateIds,
} from '../../webview/tab-view-state';
import {
  getViewState,
  markClosing,
  setViewState,
  type ViewState,
} from '../../webview/view-state-store';

const scroll = (top: number): ViewState => ({ kind: 'scroll', top });
const file = (path: string): Pick<OpenDoc, 'id' | 'kind' | 'path'> => ({
  id: `file:${path}`,
  kind: 'file',
  path,
});
const doc = file('/w/a.md');
const keys = (group: 1 | 2) => tabViewStateIds(doc).map((id) => (group === 1 ? id : `g2:${id}`));

beforeEach(() => {
  for (const id of [...keys(1), ...keys(2)]) {
    markClosing(id);
    getViewState(id);
  }
  clearHtmlView(doc.id);
  clearHtmlView(`g2:${doc.id}`);
  clearReveal(doc.path);
});

describe('tab view state (split-editor plan P5)', () => {
  it("a file tab's ids are the doc id plus its markdown, HTML and plan source ids", () => {
    expect(tabViewStateIds(doc)).toEqual([
      'file:/w/a.md',
      'markdown-source:/w/a.md',
      'html-source:/w/a.md',
      'plan-source:file:/w/a.md',
    ]);
    expect(tabViewStateIds({ id: 'review:@review', kind: 'review', path: '@review' })).toEqual([
      'review:@review',
    ]);
  });

  it('a move carries every id of the tab to the other group', () => {
    for (const [i, id] of keys(1).entries()) setViewState(id, scroll(i + 1));
    setHtmlScroll(doc.id, 40);
    carryTabState(doc, 1, 2, 'move');
    for (const [i, id] of keys(2).entries()) expect(getViewState(id)).toEqual(scroll(i + 1));
    for (const id of keys(1)) expect(getViewState(id)).toBeUndefined();
    expect(getHtmlScroll(`g2:${doc.id}`)).toBe(40);
  });

  it("dropping one group's tab evicts and tombstones every id of it there, and only there", () => {
    for (const id of [...keys(1), ...keys(2)]) setViewState(id, scroll(9));
    setHtmlScroll(`g2:${doc.id}`, 40);
    dropTabState(doc, 2);
    for (const id of keys(2)) setViewState(id, scroll(500));
    for (const id of keys(2)) expect(getViewState(id)).toBeUndefined();
    for (const id of keys(1)) expect(getViewState(id)).toEqual(scroll(9));
    expect(getHtmlScroll(`g2:${doc.id}`)).toBe(0);
  });

  it('a file tab closing in a group drops a reveal staged for that group only', () => {
    setReveal(doc.path, { line: 3, column: 1 }, 1);
    dropTabState(doc, 2);
    expect(hasReveal(doc.path, 1)).toBe(true);
    setReveal(doc.path, { line: 3, column: 1 }, 2);
    dropTabState(doc, 2);
    expect(hasReveal(doc.path)).toBe(false);
  });

  it("a commit-diff preview slot's state moves to the pinned id a split or move lands it under", () => {
    const slot = { id: 'commit-diff:@preview', kind: 'commit-diff' as const, path: 'abc:src/a.ts' };
    const pinned = 'commit-diff:abc:src/a.ts';
    for (const id of [slot.id, `g2:${slot.id}`, pinned, `g2:${pinned}`]) {
      markClosing(id);
      getViewState(id);
    }
    setViewState(slot.id, scroll(77));
    const landed = pinTabStateForMove(slot);
    expect(landed).toEqual({ ...slot, id: pinned });
    carryTabState(landed, 1, 2, 'copy');
    expect(getViewState(`g2:${pinned}`)).toEqual(scroll(77));
    expect(getViewState(pinned)).toEqual(scroll(77));
    expect(getViewState(slot.id)).toBeUndefined();
    expect(pinTabStateForMove(doc)).toBe(doc);
  });

  it('a tab moving to the other group takes a reveal staged for it along; a copy leaves it', () => {
    setReveal(doc.path, { line: 3, column: 1 }, 2);
    carryTabState(doc, 2, 1, 'move');
    expect(hasReveal(doc.path, 2)).toBe(false);
    expect(peekReveal(doc.path, 1)).toEqual({ line: 3, column: 1 });
    setReveal(doc.path, { line: 3, column: 1 }, 1);
    carryTabState(doc, 1, 2, 'copy');
    expect(hasReveal(doc.path, 1)).toBe(true);
  });
});
