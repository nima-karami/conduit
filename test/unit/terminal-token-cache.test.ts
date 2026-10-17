import { afterEach, describe, expect, it, vi } from 'vitest';
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
  expect(request).toHaveBeenCalledWith({ id: expect.any(Number), tokens: ['b'] });
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

// Plan 2026-10-16-terminal-path-links T3.0: batches, scope, TTL and generation.
interface Res {
  n: number;
}
const isNegative = (r: Res) => r.n === 0;

function pathCache(opts: { now?: () => number; ttlMs?: number } = {}) {
  const batches: Array<{ id: number; tokens: string[] }> = [];
  const cache = createTerminalTokenCache<Res>((b) => batches.push(b), {
    capacity: 100,
    timeoutMs: 1000,
    ttlMs: opts.ttlMs ?? 30_000,
    now: opts.now,
    negative: { is: isNegative, ttlMs: 5000 },
  });
  const last = () => batches[batches.length - 1];
  return { cache, batches, last };
}

describe('createTerminalTokenCache — batches, scope, TTL, generation', () => {
  it('requests the misses of one get as ONE batch, with bare tokens', async () => {
    const { cache, batches } = pathCache();
    void cache.get(['a', 'b'], 'cwd\0h');
    expect(batches).toEqual([{ id: expect.any(Number), tokens: ['a', 'b'] }]);
    cache.dispose();
  });

  it('settle resolves every pending token of the batch; absent ones are misses and uncached', async () => {
    vi.useFakeTimers();
    const { cache, batches, last } = pathCache();
    let settled: Map<string, Res> | undefined;
    void cache.get(['a', 'b'], 's').then((m) => {
      settled = m;
    });
    cache.settle(last().id, 's', new Map([['a', { n: 1 }]]));
    // Released by the settle itself, not by the 1 s timeout (no timers advanced).
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual(new Map([['a', { n: 1 }]]));
    void cache.get(['b'], 's');
    expect(batches).toHaveLength(2);
    expect(last().tokens).toEqual(['b']);
    expect(await cache.get(['a'], 's')).toEqual(new Map([['a', { n: 1 }]]));
    expect(batches).toHaveLength(2);
    cache.dispose();
  });

  it('a reply scope that differs from the lookup scope stores under the reply scope', async () => {
    const { cache, batches, last } = pathCache();
    const got = cache.get(['a'], 'cwd1\0h');
    cache.settle(last().id, 'cwd2\0h', new Map([['a', { n: 1 }]]));
    expect(await got).toEqual(new Map([['a', { n: 1 }]]));
    void cache.get(['a'], 'cwd1\0h');
    expect(batches).toHaveLength(2);
    expect(await cache.get(['a'], 'cwd2\0h')).toEqual(new Map([['a', { n: 1 }]]));
    expect(batches).toHaveLength(2);
    cache.dispose();
  });

  it('clear during in-flight: the negative is dropped, the positive is stored', async () => {
    const { cache, batches, last } = pathCache();
    const got = cache.get(['a', 'b'], 's');
    const id = last().id;
    cache.clear();
    cache.settle(
      id,
      's',
      new Map([
        ['a', { n: 1 }],
        ['b', { n: 0 }],
      ]),
    );
    expect(await got).toEqual(
      new Map([
        ['a', { n: 1 }],
        ['b', { n: 0 }],
      ]),
    );
    expect(await cache.get(['a'], 's')).toEqual(new Map([['a', { n: 1 }]]));
    expect(batches).toHaveLength(1);
    void cache.get(['b'], 's');
    expect(batches).toHaveLength(2);
    cache.dispose();
  });

  it('evictWhere during in-flight: settle does not store the stale negative, but a positive', async () => {
    const { cache, batches, last } = pathCache();
    const negWait = cache.get(['b'], 's');
    cache.evictWhere(isNegative);
    cache.settle(last().id, 's', new Map([['b', { n: 0 }]]));
    expect(await negWait).toEqual(new Map([['b', { n: 0 }]]));
    void cache.get(['b'], 's');
    expect(batches).toHaveLength(2);

    const posWait = cache.get(['c'], 's');
    cache.evictWhere(isNegative);
    cache.settle(last().id, 's', new Map([['c', { n: 2 }]]));
    expect(await posWait).toEqual(new Map([['c', { n: 2 }]]));
    expect(await cache.get(['c'], 's')).toEqual(new Map([['c', { n: 2 }]]));
    expect(batches).toHaveLength(3);
    cache.dispose();
  });

  it('ttlMs expiry', async () => {
    let t = 0;
    const { cache, batches, last } = pathCache({ now: () => t });
    void cache.get(['a'], 's');
    cache.settle(last().id, 's', new Map([['a', { n: 1 }]]));
    t = 29_999;
    await cache.get(['a'], 's');
    expect(batches).toHaveLength(1);
    t = 30_000 + 29_999 + 1;
    void cache.get(['a'], 's');
    expect(batches).toHaveLength(2);
    cache.dispose();
  });

  it('negative entries expire after negative.ttlMs (5 s) while positives live for ttlMs (30 s)', async () => {
    let t = 0;
    const { cache, batches, last } = pathCache({ now: () => t });
    void cache.get(['neg', 'pos'], 's');
    cache.settle(
      last().id,
      's',
      new Map([
        ['neg', { n: 0 }],
        ['pos', { n: 1 }],
      ]),
    );
    t = 4999;
    await cache.get(['neg', 'pos'], 's');
    expect(batches).toHaveLength(1);
    t = 5001;
    void cache.get(['neg', 'pos'], 's');
    expect(batches).toHaveLength(2);
    expect(last().tokens).toEqual(['neg']);
    cache.dispose();
  });

  it('evictWhere drops only matching values; evict drops one scoped token', async () => {
    const { cache, batches, last } = pathCache();
    void cache.get(['neg', 'pos', 'other'], 's');
    cache.settle(
      last().id,
      's',
      new Map([
        ['neg', { n: 0 }],
        ['pos', { n: 1 }],
        ['other', { n: 3 }],
      ]),
    );
    cache.evictWhere(isNegative);
    await cache.get(['pos', 'other'], 's');
    expect(batches).toHaveLength(1);
    void cache.get(['neg'], 's');
    expect(batches).toHaveLength(2);
    cache.evict('pos', 's');
    void cache.get(['pos', 'other'], 's');
    expect(last().tokens).toEqual(['pos']);
    cache.dispose();
  });

  it('timeout still settles as absent', async () => {
    vi.useFakeTimers();
    const { cache } = pathCache();
    const got = cache.get(['a'], 's');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await got).toEqual(new Map());
    cache.dispose();
  });

  it('a settle for an unknown or already-timed-out batch is harmless', async () => {
    const { cache } = pathCache();
    cache.settle(999, 's', new Map([['x', { n: 1 }]]));
    expect(await cache.get(['x'], 's')).toEqual(new Map([['x', { n: 1 }]]));
    cache.dispose();
  });
});
