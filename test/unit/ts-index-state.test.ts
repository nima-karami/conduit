import { describe, expect, it } from 'vitest';
import { createIndexTracker, flushImmediately } from '../../webview/ts-index-state';

const note = (
  over: Partial<Parameters<ReturnType<typeof createIndexTracker>['note']>[1]> = {},
) => ({
  total: 0,
  done: false,
  skipped: 0,
  capped: 0,
  ...over,
});

describe('createIndexTracker', () => {
  it('is not "done" before anything has been indexed', () => {
    // Reporting an empty index as complete would make every failed lookup in a fresh window
    // claim the symbol doesn't exist, instead of "still warming up".
    expect(createIndexTracker().status()).toEqual({
      total: 0,
      loaded: 0,
      done: false,
      skipped: 0,
      capped: 0,
    });
  });

  it('tracks progress through a stream of chunks', () => {
    const t = createIndexTracker();
    t.note('G:/r', note({ total: 500 }));
    t.markLoaded(200);
    expect(t.status()).toMatchObject({ total: 500, loaded: 200, done: false });
    t.note('G:/r', note({ total: 500, done: true }));
    t.markLoaded(300);
    expect(t.status()).toMatchObject({ total: 500, loaded: 500, done: true });
  });

  it('is done only when EVERY root has finished', () => {
    const t = createIndexTracker();
    t.note('G:/a', note({ total: 10, done: true }));
    t.note('G:/b', note({ total: 5 }));
    expect(t.status()).toMatchObject({ total: 15, done: false });
    t.note('G:/b', note({ total: 5, done: true }));
    expect(t.status()).toMatchObject({ total: 15, done: true });
  });

  it('does not double-count a root re-reporting its total', () => {
    const t = createIndexTracker();
    t.note('G:/r', note({ total: 500 }));
    t.note('G:/r', note({ total: 500 }));
    expect(t.status().total).toBe(500);
  });

  it('sums skipped and capped across roots, replacing each root’s own counts', () => {
    const t = createIndexTracker();
    t.note('G:/a', note({ total: 10, done: true, skipped: 2, capped: 100 }));
    t.note('G:/b', note({ total: 5, done: true, skipped: 1, capped: 0 }));
    expect(t.status()).toMatchObject({ skipped: 3, capped: 100 });
    // A later chunk for the same root carries the same absolute counts — not more of them.
    t.note('G:/a', note({ total: 10, done: true, skipped: 2, capped: 100 }));
    expect(t.status()).toMatchObject({ skipped: 3, capped: 100 });
  });

  it('adds a supplemental chunk to the root’s total instead of replacing it', () => {
    // The top-up's `total` is the size of THAT batch: the files are new, so counting them as
    // the root's whole total would make progress read "3 of 3" over a 500-file index.
    const t = createIndexTracker();
    t.note('G:/r', note({ total: 500, done: true }));
    t.markLoaded(500);
    t.note('G:/r', note({ total: 3, done: true, supplemental: true }));
    t.markLoaded(3);
    expect(t.status()).toMatchObject({ total: 503, loaded: 503, done: true });
  });

  it('treats a supplemental chunk for an unknown root as that root’s first total', () => {
    const t = createIndexTracker();
    t.note('G:/r', note({ total: 3, done: true, supplemental: true }));
    expect(t.status()).toMatchObject({ total: 3, done: true });
  });

  it('resets', () => {
    const t = createIndexTracker();
    t.note('G:/r', note({ total: 9, done: true, skipped: 1, capped: 2 }));
    t.markLoaded(9);
    t.reset();
    expect(t.status()).toEqual({ total: 0, loaded: 0, done: false, skipped: 0, capped: 0 });
  });
});

describe('flushImmediately', () => {
  it('flushes the priority wave and the final chunk, coalescing the rest', () => {
    expect(flushImmediately(0, false)).toBe(true);
    expect(flushImmediately(7, true)).toBe(true);
    expect(flushImmediately(3, false)).toBe(false);
  });
});

describe('supplemental resolutions and the project counters', () => {
  it('an on-demand resolution must not move "N of M"', () => {
    // The contract `webview/ts-project.ts`'s `addIndexedFiles` relies on: it pushes extraLibs
    // and deliberately never touches the tracker, so "Still indexing (200 of 900)" stays true
    // about the PROJECT while a package is pulled in beside it.
    const t = createIndexTracker();
    t.note('g:/p', note({ total: 900, done: false }));
    t.markLoaded(200);
    expect(t.status()).toMatchObject({ total: 900, loaded: 200, done: false });
  });
});
