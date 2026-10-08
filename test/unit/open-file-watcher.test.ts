import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenFileWatcher, planWatchDirs } from '../../electron/open-file-watcher';

// The directory watch is the OS seam: replaced so a test can fire the raw events it would deliver.
const dirEvents = new Map<string, (event: string, filename: string | null) => void>();
vi.mock('../../electron/watch-dir', () => ({
  watchDirWhilePresent: (
    dir: string,
    _opts: unknown,
    onEvent: (event: string, filename: string | null) => void,
  ) => {
    dirEvents.set(dir, onEvent);
    return { close: () => dirEvents.delete(dir) };
  },
}));

describe('OpenFileWatcher change cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const writeTo = (file: string) =>
    dirEvents.get(path.dirname(file))?.('change', path.basename(file));

  it('debounces a source file: a burst of writes is one change, after the burst', () => {
    const file = path.join('r', 'a.ts');
    const seen: string[] = [];
    const w = new OpenFileWatcher((p) => seen.push(p), 150);
    w.setPaths([file]);
    for (let i = 0; i < 10; i++) {
      writeTo(file);
      vi.advanceTimersByTime(100);
    }
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(seen).toEqual([file]);
    w.stop();
  });

  // An agent appending to a log never pauses, so a debounce would never fire.
  it('throttles a log to one trailing change per second while it keeps being written', () => {
    const file = path.join('r', 'app.log.1');
    const seen: number[] = [];
    const w = new OpenFileWatcher(() => seen.push(Date.now()), 150);
    w.setPaths([file]);
    const start = Date.now();
    for (let i = 0; i < 30; i++) {
      writeTo(file);
      vi.advanceTimersByTime(100);
    }
    expect(seen.map((t) => t - start)).toEqual([1000, 2000, 3000]);
    w.stop();
  });
});

describe('planWatchDirs', () => {
  it('groups files under their parent directory', () => {
    const plan = planWatchDirs([
      path.join('a', 'b', 'one.ts'),
      path.join('a', 'b', 'two.ts'),
      path.join('a', 'c', 'three.ts'),
    ]);
    expect(plan.get(path.join('a', 'b'))).toEqual(new Set(['one.ts', 'two.ts']));
    expect(plan.get(path.join('a', 'c'))).toEqual(new Set(['three.ts']));
    expect(plan.size).toBe(2);
  });

  it('dedups identical paths within a directory', () => {
    const p = path.join('x', 'y', 'dup.ts');
    const plan = planWatchDirs([p, p]);
    expect(plan.get(path.join('x', 'y'))).toEqual(new Set(['dup.ts']));
  });

  it('ignores empty/falsy entries', () => {
    const plan = planWatchDirs(['', path.join('d', 'f.ts')]);
    expect(plan.size).toBe(1);
    expect(plan.get('d')).toEqual(new Set(['f.ts']));
  });

  it('returns an empty map for no paths', () => {
    expect(planWatchDirs([]).size).toBe(0);
  });
});
