import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planWatchDirs } from '../../electron/open-file-watcher';

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
