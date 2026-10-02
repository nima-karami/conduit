import { expect, it } from 'vitest';
import { coalescedRefresh } from '../../src/coalesced-refresh';

it('runs one refresh at a time and coalesces waiting requests into a fresh follow-up', async () => {
  const calls: number[] = [];
  const releases: (() => void)[] = [];
  const refresh = coalescedRefresh(
    async (_root: string, revision: number) => {
      calls.push(revision);
      await new Promise<void>((resolve) => releases.push(resolve));
      return revision;
    },
    (root: string) => root,
  );
  const first = refresh('/a', 1);
  const second = refresh('/a', 2);
  const third = refresh('/a', 3);
  expect(calls).toEqual([1]);
  releases.shift()?.();
  expect(await first).toBe(1);
  expect(calls).toEqual([1, 3]);
  releases.shift()?.();
  expect(await Promise.all([second, third])).toEqual([3, 3]);
});

it('keeps unrelated projects independent and releases entries after rejection', async () => {
  let fail = true;
  const refresh = coalescedRefresh(
    async (root: string) => {
      if (fail && root === '/a') throw new Error('failed');
      return root;
    },
    (root: string) => root,
  );
  expect(await refresh('/b')).toBe('/b');
  await expect(refresh('/a')).rejects.toThrow('failed');
  fail = false;
  expect(await refresh('/a')).toBe('/a');
});

it('a failed running refresh still runs queued requests and later invalidations', async () => {
  const releases: (() => void)[] = [];
  const calls: number[] = [];
  const refresh = coalescedRefresh(
    async (_root: string, revision: number) => {
      calls.push(revision);
      await new Promise<void>((resolve) => releases.push(resolve));
      if (revision === 1) throw new Error('old refresh failed');
      return revision;
    },
    (root: string) => root,
  );
  const first = refresh('/a', 1);
  const rejected = expect(first).rejects.toThrow('old refresh failed');
  const second = refresh('/a', 2);
  releases.shift()?.();
  await rejected;
  const third = refresh('/a', 3);
  expect(calls).toEqual([1, 2]);
  releases.shift()?.();
  expect(await second).toBe(2);
  expect(calls).toEqual([1, 2, 3]);
  releases.shift()?.();
  expect(await third).toBe(3);
});
