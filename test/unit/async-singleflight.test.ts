import { expect, it, vi } from 'vitest';
import { asyncSingleFlight } from '../../src/async-singleflight';

it('shares overlapping requests by canonical key and starts a fresh subsequent wave', async () => {
  let finish: (value: string[]) => void = () => {};
  const scan = vi.fn(
    (_root: string) =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const shared = asyncSingleFlight(scan, (root) => root.toLowerCase());
  const first = shared('ROOT');
  const second = shared('root');
  expect(first).toBe(second);
  expect(scan).toHaveBeenCalledTimes(1);
  finish(['repo']);
  expect(await first).toEqual(['repo']);
  const next = shared('ROOT');
  expect(next).not.toBe(first);
  expect(scan).toHaveBeenCalledTimes(2);
  finish(['new-repo']);
  expect(await next).toEqual(['new-repo']);
});

it('clears rejected work so the next request can succeed', async () => {
  const scan = vi.fn().mockRejectedValueOnce(new Error('scan failed')).mockResolvedValueOnce('ok');
  const shared = asyncSingleFlight(scan);
  const first = shared('root');
  expect(shared('root')).toBe(first);
  await expect(first).rejects.toThrow('scan failed');
  expect(await shared('root')).toBe('ok');
  expect(scan).toHaveBeenCalledTimes(2);
});

it('runs independent roots concurrently', async () => {
  const scan = vi.fn(async (root: string) => root);
  const shared = asyncSingleFlight(scan);
  const first = shared('a');
  const second = shared('b');
  expect(first).not.toBe(second);
  expect(await Promise.all([first, second])).toEqual(['a', 'b']);
  expect(scan).toHaveBeenCalledTimes(2);
});
