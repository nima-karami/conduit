import { describe, expect, it } from 'vitest';
import { createIndexTracker, flushImmediately } from '../../webview/ts-index-state';

describe('createIndexTracker', () => {
  it('is not "done" before anything has been indexed', () => {
    // Reporting an empty index as complete would make every failed lookup in a fresh window
    // claim the symbol doesn't exist, instead of "still warming up".
    expect(createIndexTracker().status()).toEqual({ total: 0, loaded: 0, done: false });
  });

  it('tracks progress through a stream of chunks', () => {
    const t = createIndexTracker();
    t.note('G:/r', 500, false);
    t.markLoaded(200);
    expect(t.status()).toEqual({ total: 500, loaded: 200, done: false });
    t.note('G:/r', 500, true);
    t.markLoaded(300);
    expect(t.status()).toEqual({ total: 500, loaded: 500, done: true });
  });

  it('is done only when EVERY root has finished', () => {
    const t = createIndexTracker();
    t.note('G:/a', 10, true);
    t.note('G:/b', 5, false);
    expect(t.status()).toMatchObject({ total: 15, done: false });
    t.note('G:/b', 5, true);
    expect(t.status()).toMatchObject({ total: 15, done: true });
  });

  it('does not double-count a root re-reporting its total', () => {
    const t = createIndexTracker();
    t.note('G:/r', 500, false);
    t.note('G:/r', 500, false);
    expect(t.status().total).toBe(500);
  });

  it('resets', () => {
    const t = createIndexTracker();
    t.note('G:/r', 9, true);
    t.markLoaded(9);
    t.reset();
    expect(t.status()).toEqual({ total: 0, loaded: 0, done: false });
  });
});

describe('flushImmediately', () => {
  it('flushes the priority wave and the final chunk, coalescing the rest', () => {
    expect(flushImmediately(0, false)).toBe(true);
    expect(flushImmediately(7, true)).toBe(true);
    expect(flushImmediately(3, false)).toBe(false);
  });
});
