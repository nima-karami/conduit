import { describe, expect, it } from 'vitest';
import { resolveCacheKey } from '../../src/module-resolver-fs';

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
