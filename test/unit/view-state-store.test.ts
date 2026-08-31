import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireReviewListState,
  adoptReviewSource,
  clampScrollTop,
  getViewState,
  markClosing,
  mergeReviewViewState,
  mergeScrollViewState,
  setViewState,
  type ViewState,
} from '../../webview/view-state-store';

const scroll = (top: number): ViewState => ({ kind: 'scroll', top });

describe('view-state-store', () => {
  beforeEach(() => {
    // The store is a module singleton: markClosing evicts, and the getViewState after it clears
    // the tombstone markClosing leaves behind.
    for (const id of ['file:/a.ts', 'file:/b.ts', 'review:@review', 'history:@h']) {
      markClosing(id);
      getViewState(id);
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

  it('mergeScrollViewState creates a scroll entry from nothing', () => {
    mergeScrollViewState('history:@h', { top: 240 });
    expect(getViewState('history:@h')).toEqual({ kind: 'scroll', top: 240 });
  });

  it('setting selection preserves a previously stored scroll top', () => {
    mergeScrollViewState('history:@h', { top: 300 });
    mergeScrollViewState('history:@h', { selectedSha: 'abc123' });
    expect(getViewState('history:@h')).toEqual({
      kind: 'scroll',
      top: 300,
      selectedSha: 'abc123',
    });
  });

  it('setting scroll preserves a previously stored selection', () => {
    mergeScrollViewState('history:@h', { selectedSha: 'abc123' });
    mergeScrollViewState('history:@h', { top: 512 });
    expect(getViewState('history:@h')).toEqual({
      kind: 'scroll',
      top: 512,
      selectedSha: 'abc123',
    });
  });

  it('clearing the selection keeps scroll top and drops selectedSha', () => {
    mergeScrollViewState('history:@h', { top: 90, selectedSha: 'abc123' });
    mergeScrollViewState('history:@h', { selectedSha: null });
    expect(getViewState('history:@h')).toEqual({ kind: 'scroll', top: 90 });
  });

  it('merging over a non-scroll entry replaces it with a scroll base', () => {
    setViewState('history:@h', { kind: 'monaco', state: null });
    mergeScrollViewState('history:@h', { selectedSha: 'abc123' });
    expect(getViewState('history:@h')).toEqual({
      kind: 'scroll',
      top: 0,
      selectedSha: 'abc123',
    });
  });

  it('mergeScrollViewState respects the closing tombstone', () => {
    mergeScrollViewState('history:@h', { top: 90, selectedSha: 'abc123' });
    markClosing('history:@h');
    mergeScrollViewState('history:@h', { top: 90, selectedSha: 'abc123' });
    expect(getViewState('history:@h')).toBeUndefined();
  });

  it('stores a reviewAnchor shape', () => {
    const list = acquireReviewListState('review:@review');
    setViewState('review:@review', { kind: 'reviewAnchor', topPath: 'src/x.ts', offset: 8, list });
    expect(getViewState('review:@review')).toMatchObject({
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

describe('mergeReviewViewState', () => {
  const ID = 'review:@review';
  beforeEach(() => {
    markClosing(ID);
    getViewState(ID);
  });

  it('starts from an empty anchor when nothing is stored', () => {
    mergeReviewViewState(ID, {});
    expect(getViewState(ID)).toMatchObject({ kind: 'reviewAnchor', topPath: '', offset: 0 });
  });

  it('moves the anchor', () => {
    mergeReviewViewState(ID, { anchor: { topPath: 'b.ts', offset: 40 } });
    expect(getViewState(ID)).toMatchObject({ kind: 'reviewAnchor', topPath: 'b.ts', offset: 40 });
  });

  it('overwrites a non-review entry rather than merging into it', () => {
    setViewState(ID, scroll(120));
    mergeReviewViewState(ID, {});
    expect(getViewState(ID)).toMatchObject({ kind: 'reviewAnchor', topPath: '', offset: 0 });
  });

  it('is dropped by markClosing and ignores a late write from the dying view', () => {
    mergeReviewViewState(ID, { anchor: { topPath: 'b.ts', offset: 40 } });
    markClosing(ID);
    mergeReviewViewState(ID, { anchor: { topPath: 'a.ts', offset: 10 } });
    expect(getViewState(ID)).toBeUndefined();
  });
});

describe('review list state', () => {
  const ID = 'review:@review';
  beforeEach(() => {
    markClosing(ID);
    getViewState(ID);
  });

  it('hands the same bag back on a remount, so the view can alias its maps', () => {
    const first = acquireReviewListState(ID);
    first.ui.set('a.ts', { folds: new Map(), showRemaining: true, collapsed: true });
    first.measured.set('a.ts', 412);
    expect(acquireReviewListState(ID)).toBe(first);
    expect(acquireReviewListState(ID).ui.get('a.ts')?.collapsed).toBe(true);
    expect(acquireReviewListState(ID).measured.get('a.ts')).toBe(412);
  });

  it('keeps the bag when the anchor moves', () => {
    const list = acquireReviewListState(ID);
    list.filter = 'src/';
    mergeReviewViewState(ID, { anchor: { topPath: 'b.ts', offset: 12 } });
    expect(acquireReviewListState(ID)).toBe(list);
    expect(acquireReviewListState(ID).filter).toBe('src/');
  });

  it('attaches a bag to an anchor merged from nothing', () => {
    mergeReviewViewState(ID, { anchor: { topPath: 'b.ts', offset: 12 } });
    const entry = getViewState(ID);
    expect(entry?.kind).toBe('reviewAnchor');
    expect(entry?.kind === 'reviewAnchor' && entry.list.ui).toBeInstanceOf(Map);
  });

  it('gives an id-less list its own throwaway bag', () => {
    const a = acquireReviewListState(undefined);
    const b = acquireReviewListState(undefined);
    expect(a).not.toBe(b);
    expect(getViewState(ID)).toBeUndefined();
  });

  /** A list carrying state built for `sourceKey`. */
  const listFor = (sourceKey: string) => {
    const list = acquireReviewListState(ID);
    adoptReviewSource(ID, sourceKey);
    list.ui.set('a.ts', { folds: new Map(), showRemaining: true, collapsed: true });
    list.measured.set('a.ts', 412);
    list.filter = 'src/';
    mergeReviewViewState(ID, { anchor: { topPath: 'a.ts', offset: 90 } });
    return list;
  };

  it('a source change drops the per-path caches and the anchor, IN PLACE', () => {
    const list = listFor('working');

    expect(adoptReviewSource(ID, 'commit:abc123')).toBe(true);

    // Same object: a mounted view holds these maps by reference and must see them emptied.
    expect(acquireReviewListState(ID)).toBe(list);
    expect(list.ui.size).toBe(0);
    expect(list.measured.size).toBe(0);
    expect(getViewState(ID)).toMatchObject({ topPath: '', offset: 0 });
    // The find bar and the file filter are not content — a source change leaves them alone.
    expect(list.filter).toBe('src/');
  });

  it('re-adopting the SAME source keeps everything — a tab switch is not a content change', () => {
    const list = listFor('working');

    expect(adoptReviewSource(ID, 'working')).toBe(false);

    expect(list.ui.size).toBe(1);
    expect(list.measured.get('a.ts')).toBe(412);
    expect(getViewState(ID)).toMatchObject({ topPath: 'a.ts', offset: 90 });
  });

  it('catches a source change made while the view was UNMOUNTED', () => {
    // Review is a singleton doc: "Review this commit" retargets the source and activates the tab
    // in one dispatch, so the view that has to reset is one mounting fresh. An instance ref born
    // on that mount sees only the new key; the store still holds the old one.
    const list = listFor('working');
    list.ui.set('kept.ts', { folds: new Map(), showRemaining: true, collapsed: true });

    // …view unmounts, source is retargeted, view mounts again and adopts on its first render.
    const remounted = acquireReviewListState(ID);
    expect(remounted).toBe(list);
    expect(adoptReviewSource(ID, 'commit:abc123')).toBe(true);
    expect(remounted.ui.size).toBe(0);
    expect(remounted.measured.size).toBe(0);
  });

  it('a first adopt on a fresh bag reports a reset without anything to lose', () => {
    expect(adoptReviewSource(ID, 'working')).toBe(true);
    expect(acquireReviewListState(ID).sourceKey).toBe('working');
  });

  it('markClosing drops the bag, so a reopened tab starts pristine', () => {
    const list = acquireReviewListState(ID);
    list.ui.set('a.ts', { folds: new Map(), showRemaining: true, collapsed: true });
    list.filter = 'src/';
    markClosing(ID);
    const reopened = acquireReviewListState(ID);
    expect(reopened).not.toBe(list);
    expect(reopened.ui.size).toBe(0);
    expect(reopened.filter).toBe('');
  });

  it('a dying view cannot resurrect its anchor after markClosing', () => {
    acquireReviewListState(ID);
    mergeReviewViewState(ID, { anchor: { topPath: 'a.ts', offset: 90 } });
    markClosing(ID);
    mergeReviewViewState(ID, { anchor: { topPath: 'a.ts', offset: 90 } });
    expect(getViewState(ID)).toBeUndefined();
  });
});
