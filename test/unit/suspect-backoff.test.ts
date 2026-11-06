import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSuspectBackoff, SUSPECT_WINDOW_MS } from '../../src/suspect-backoff';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const rechecks: string[] = [];
  const backoff = createSuspectBackoff<string>({
    windowMs: SUSPECT_WINDOW_MS,
    onRecheck: (value, repeats) => rechecks.push(`${value}x${repeats}`),
  });
  const b = { hit: (key: string) => backoff.hit(key, key), dispose: () => backoff.dispose() };
  return { b, backoff, rechecks };
}

describe('createSuspectBackoff', () => {
  it('the first suspect for a folder rechecks at once', () => {
    const h = setup();
    h.b.hit('c:/home');
    expect(h.rechecks).toEqual(['c:/homex1']);
  });

  it('repeats within the window coalesce into one trailing recheck carrying their count', () => {
    const h = setup();
    h.b.hit('c:/home');
    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(1000);
      h.b.hit('c:/home');
    }
    expect(h.rechecks).toEqual(['c:/homex1']);
    vi.advanceTimersByTime(SUSPECT_WINDOW_MS - 29_000);
    expect(h.rechecks).toEqual(['c:/homex1', 'c:/homex29']);
  });

  it('a steady stream rechecks once per window, never more', () => {
    const h = setup();
    for (let s = 0; s < 120; s++) {
      h.b.hit('c:/home');
      vi.advanceTimersByTime(1000);
    }
    expect(h.rechecks.length).toBeLessThanOrEqual(1 + 120_000 / SUSPECT_WINDOW_MS);
    expect(h.rechecks.length).toBeGreaterThanOrEqual(120_000 / SUSPECT_WINDOW_MS);
  });

  it('a window with no repeat ends quietly; the next suspect after it is immediate again', () => {
    const h = setup();
    h.b.hit('c:/home');
    vi.advanceTimersByTime(SUSPECT_WINDOW_MS * 3);
    expect(h.rechecks).toEqual(['c:/homex1']);
    h.b.hit('c:/home');
    expect(h.rechecks).toEqual(['c:/homex1', 'c:/homex1']);
  });

  it('folders back off independently', () => {
    const h = setup();
    h.b.hit('c:/a');
    h.b.hit('c:/a');
    h.b.hit('c:/b');
    expect(h.rechecks).toEqual(['c:/ax1', 'c:/bx1']);
  });

  it('the trailing recheck carries the latest value hit for that key', () => {
    const h = setup();
    h.backoff.hit('c:/home', 'C:/Home');
    h.backoff.hit('c:/home', 'c:/HOME');
    vi.advanceTimersByTime(SUSPECT_WINDOW_MS);
    expect(h.rechecks).toEqual(['C:/Homex1', 'c:/HOMEx1']);
  });

  it('dispose drops pending trailing rechecks', () => {
    const h = setup();
    h.b.hit('c:/a');
    h.b.hit('c:/a');
    h.b.dispose();
    vi.advanceTimersByTime(SUSPECT_WINDOW_MS);
    expect(h.rechecks).toEqual(['c:/ax1']);
  });
});
