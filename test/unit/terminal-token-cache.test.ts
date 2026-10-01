import { afterEach, expect, it, vi } from 'vitest';
import { createTerminalTokenCache } from '../../webview/terminal-token-cache';

afterEach(() => vi.useRealTimers());

it('bounds cached resolutions and treats cached null as a hit', async () => {
  const request = vi.fn();
  const cache = createTerminalTokenCache<string | null>(request, { capacity: 2, timeoutMs: 100 });
  cache.resolve('a', null);
  cache.resolve('b', 'B');
  expect(await cache.get(['a'])).toEqual(new Map([['a', null]]));
  cache.resolve('c', 'C');
  const waiting = cache.get(['b']);
  expect(request).toHaveBeenCalledWith(['b']);
  cache.resolve('b', 'fresh');
  expect(await waiting).toEqual(new Map([['b', 'fresh']]));
  cache.dispose();
});

it('deduplicates requests, expires missing replies and permits retry', async () => {
  vi.useFakeTimers();
  const request = vi.fn();
  const cache = createTerminalTokenCache<string>(request, { capacity: 2, timeoutMs: 100 });
  const first = cache.get(['missing']);
  const second = cache.get(['missing']);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(await first).toEqual(new Map());
  expect(await second).toEqual(new Map());
  const retry = cache.get(['missing']);
  expect(request).toHaveBeenCalledTimes(2);
  cache.dispose();
  expect(await retry).toEqual(new Map());
  expect(vi.getTimerCount()).toBe(0);
});
