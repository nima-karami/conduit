import { describe, expect, it, vi } from 'vitest';
import { createAsyncMemo } from '../../src/git-memo';

describe('createAsyncMemo', () => {
  it('loads once and serves the cached value inside the TTL', async () => {
    let clock = 0;
    const memo = createAsyncMemo<string>({ ttlMs: 100, max: 10, now: () => clock });
    const load = vi.fn(async () => 'root');
    expect(await memo.get('a', load)).toBe('root');
    clock = 99;
    expect(await memo.get('a', load)).toBe('root');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after the TTL expires', async () => {
    let clock = 0;
    const memo = createAsyncMemo<string>({ ttlMs: 100, max: 10, now: () => clock });
    const load = vi.fn(async () => `v${clock}`);
    await memo.get('a', load);
    clock = 101;
    expect(await memo.get('a', load)).toBe('v101');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    let resolve: (v: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const all = Promise.all([memo.get('a', load), memo.get('a', load), memo.get('a', load)]);
    resolve('shared');
    expect(await all).toEqual(['shared', 'shared', 'shared']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keys entries independently', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    expect(await memo.get('a', async () => 'A')).toBe('A');
    expect(await memo.get('b', async () => 'B')).toBe('B');
    expect(await memo.get('a', async () => 'NEW')).toBe('A');
  });

  it('evicts the oldest entry past the bound', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 2 });
    await memo.get('a', async () => 'A');
    await memo.get('b', async () => 'B');
    await memo.get('c', async () => 'C');
    const reload = vi.fn(async () => 'A2');
    expect(await memo.get('a', reload)).toBe('A2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected load', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    await expect(
      memo.get('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await memo.get('a', async () => 'recovered')).toBe('recovered');
  });

  it('clear drops everything', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    await memo.get('a', async () => 'A');
    memo.clear();
    expect(await memo.get('a', async () => 'B')).toBe('B');
  });
});
