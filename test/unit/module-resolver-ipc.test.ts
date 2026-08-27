import { describe, expect, it } from 'vitest';
import { dropResolutionsForRoot, resolveCacheKey } from '../../src/module-resolver-fs';

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
