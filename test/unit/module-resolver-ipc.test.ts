import { describe, expect, it } from 'vitest';
import {
  type CachedResolution,
  dropResolutionsForRoot,
  RESOLVE_CACHE_MAX_BYTES,
  RESOLVE_CACHE_MAX_ENTRIES,
  rememberResolution,
  resolutionBytes,
  resolveCacheKey,
  touchResolution,
} from '../../src/module-resolver-fs';

describe('resolveCacheKey', () => {
  it('keys on root, importing DIRECTORY and specifier — two files in one dir share a hit', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod')).toBe(
      resolveCacheKey('g:/p', 'g:/p/src/b.ts', 'zod'),
    );
  });

  it('separates different directories — nested node_modules must not collide', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'dep')).not.toBe(
      resolveCacheKey('g:/p', 'g:/p/apps/web/src/a.ts', 'dep'),
    );
  });

  it('separates roots and specifiers', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod')).not.toBe(
      resolveCacheKey('g:/q', 'g:/q/src/a.ts', 'zod'),
    );
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod')).not.toBe(
      resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod/v3'),
    );
  });

  it('normalizes separators so a Windows path and its forward-slash twin share one entry', () => {
    expect(resolveCacheKey('g:\\p', 'g:\\p\\src\\a.ts', 'zod')).toBe(
      resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod'),
    );
  });

  it('is prefixed by the root so a whole root can be dropped by prefix', () => {
    expect(resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod').startsWith('g:/p\0')).toBe(true);
  });
});

describe('dropResolutionsForRoot', () => {
  it('drops only the given root', () => {
    const cache = new Map<string, unknown>([
      [resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'zod'), 1],
      [resolveCacheKey('g:/p', 'g:/p/src/a.ts', 'lodash'), 1],
      [resolveCacheKey('g:/q', 'g:/q/src/a.ts', 'zod'), 1],
    ]);
    expect(dropResolutionsForRoot(cache, 'g:/p')).toBe(2);
    expect([...cache.keys()]).toHaveLength(1);
  });

  it('does not drop a sibling root that shares a prefix', () => {
    const cache = new Map<string, unknown>([
      [resolveCacheKey('g:/proj', 'g:/proj/a.ts', 'zod'), 1],
      [resolveCacheKey('g:/proj-two', 'g:/proj-two/a.ts', 'zod'), 1],
    ]);
    expect(dropResolutionsForRoot(cache, 'g:/proj')).toBe(1);
  });

  it('normalizes the root it is given', () => {
    const cache = new Map<string, unknown>([[resolveCacheKey('g:/p', 'g:/p/a.ts', 'zod'), 1]]);
    expect(dropResolutionsForRoot(cache, 'g:\\p')).toBe(1);
  });

  it('is a no-op for a root with nothing cached', () => {
    const cache = new Map<string, unknown>([[resolveCacheKey('g:/p', 'g:/p/a.ts', 'zod'), 1]]);
    expect(dropResolutionsForRoot(cache, 'g:/other')).toBe(0);
    expect(cache.size).toBe(1);
  });
});

describe('resolve cache bounds', () => {
  const entry = (bytes: number): CachedResolution => ({
    entry: 'g:/p/node_modules/x/index.d.ts',
    files: [
      {
        path: 'g:/p/node_modules/x/index.d.ts',
        content: 'x'.repeat(bytes),
        language: 'typescript',
      },
    ],
  });

  it(`counts an entry's bytes as its file contents, and a remembered failure as none`, () => {
    expect(resolutionBytes(entry(1234))).toBe(1234);
    expect(resolutionBytes({ failed: 'not-found' })).toBe(0);
  });

  it('evicts the least recently used once the entry cap is passed', () => {
    const cache = new Map<string, CachedResolution>();
    for (let i = 0; i < RESOLVE_CACHE_MAX_ENTRIES + 10; i++) {
      rememberResolution(cache, `k${i}`, entry(10));
    }
    expect(cache.size).toBe(RESOLVE_CACHE_MAX_ENTRIES);
    expect(cache.has('k0')).toBe(false);
    expect(cache.has(`k${RESOLVE_CACHE_MAX_ENTRIES + 9}`)).toBe(true);
  });

  it('a read keeps an entry alive — that is what makes eviction LRU and not FIFO', () => {
    const cache = new Map<string, CachedResolution>();
    for (let i = 0; i < RESOLVE_CACHE_MAX_ENTRIES; i++)
      rememberResolution(cache, `k${i}`, entry(10));
    expect(touchResolution(cache, 'k0')).toBeDefined();
    rememberResolution(cache, 'fresh', entry(10));
    expect(cache.has('k0')).toBe(true);
    expect(cache.has('k1')).toBe(false);
  });

  it('evicts on the BYTE budget while still under the entry cap', () => {
    const cache = new Map<string, CachedResolution>();
    const each = Math.floor(RESOLVE_CACHE_MAX_BYTES / 4);
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) rememberResolution(cache, k, entry(each));
    expect(cache.size).toBeLessThan(6);
    let bytes = 0;
    for (const v of cache.values()) bytes += resolutionBytes(v);
    expect(bytes).toBeLessThanOrEqual(RESOLVE_CACHE_MAX_BYTES);
    expect(cache.has('f')).toBe(true);
  });

  it('never evicts the entry it was just given, even oversize', () => {
    const cache = new Map<string, CachedResolution>();
    rememberResolution(cache, 'huge', entry(RESOLVE_CACHE_MAX_BYTES + 1));
    expect(cache.has('huge')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('touching a missing key reports nothing and adds nothing', () => {
    const cache = new Map<string, CachedResolution>();
    expect(touchResolution(cache, 'nope')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
