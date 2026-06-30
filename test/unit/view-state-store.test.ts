import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampScrollTop,
  deleteViewState,
  getViewState,
  markClosing,
  setViewState,
  type ViewState,
} from '../../webview/view-state-store';

const scroll = (top: number): ViewState => ({ kind: 'scroll', top });

describe('view-state-store', () => {
  beforeEach(() => {
    // The store is a module singleton; clear both the entry and any markClosing tombstone for the
    // ids this suite touches (getViewState clears the tombstone; deleteViewState clears the entry).
    for (const id of ['file:/a.ts', 'file:/b.ts', 'review:@review']) {
      getViewState(id);
      deleteViewState(id);
    }
  });

  it('returns undefined for an unknown id', () => {
    expect(getViewState('file:/a.ts')).toBeUndefined();
  });

  it('round-trips a set value', () => {
    setViewState('file:/a.ts', scroll(120));
    expect(getViewState('file:/a.ts')).toEqual({ kind: 'scroll', top: 120 });
  });

  it('overwrites an existing entry', () => {
    setViewState('file:/a.ts', scroll(120));
    setViewState('file:/a.ts', scroll(340));
    expect(getViewState('file:/a.ts')).toEqual({ kind: 'scroll', top: 340 });
  });

  it('keeps entries independent by id', () => {
    setViewState('file:/a.ts', scroll(10));
    setViewState('file:/b.ts', scroll(20));
    expect(getViewState('file:/a.ts')).toEqual(scroll(10));
    expect(getViewState('file:/b.ts')).toEqual(scroll(20));
  });

  it('evicts an entry (and stays evicted)', () => {
    setViewState('file:/a.ts', scroll(10));
    deleteViewState('file:/a.ts');
    expect(getViewState('file:/a.ts')).toBeUndefined();
  });

  it('delete of a missing id is a no-op', () => {
    expect(() => deleteViewState('file:/missing')).not.toThrow();
  });

  it('markClosing evicts AND blocks a dying viewer late capture from resurrecting it', () => {
    setViewState('file:/a.ts', scroll(938));
    markClosing('file:/a.ts');
    // The closing viewer's synchronous unmount capture fires after eviction — must be ignored.
    setViewState('file:/a.ts', scroll(938));
    expect(getViewState('file:/a.ts')).toBeUndefined();
  });

  it('a reopen mount-read clears the tombstone so the reopened doc captures again', () => {
    setViewState('file:/a.ts', scroll(938));
    markClosing('file:/a.ts');
    expect(getViewState('file:/a.ts')).toBeUndefined(); // reopen: mount-read clears the tombstone
    setViewState('file:/a.ts', scroll(40)); // user scrolls the reopened doc
    expect(getViewState('file:/a.ts')).toEqual(scroll(40));
  });

  it('stores a reviewAnchor shape', () => {
    setViewState('review:@review', { kind: 'reviewAnchor', topPath: 'src/x.ts', offset: 8 });
    expect(getViewState('review:@review')).toEqual({
      kind: 'reviewAnchor',
      topPath: 'src/x.ts',
      offset: 8,
    });
  });
});

describe('clampScrollTop', () => {
  it('passes a value within range through unchanged', () => {
    expect(clampScrollTop(300, 1000, 400)).toBe(300);
  });

  it('clamps a value past content end to the max scroll', () => {
    // max = scrollHeight - clientHeight = 600
    expect(clampScrollTop(5000, 1000, 400)).toBe(600);
  });

  it('clamps a negative value to 0', () => {
    expect(clampScrollTop(-50, 1000, 400)).toBe(0);
  });

  it('returns 0 when content is shorter than the viewport', () => {
    expect(clampScrollTop(120, 200, 400)).toBe(0);
  });
});
