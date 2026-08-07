import { describe, expect, it } from 'vitest';
import { importClosure, resolveRelative, scanImports } from '../../src/import-graph';

describe('scanImports', () => {
  it('finds specifiers across the syntaxes a source file actually uses', () => {
    const src = `
      import a from './a';
      import type { B } from "./b";
      export * from './c';
      const d = await import('./d');
      const e = require('./e');
      import './side-effect';
    `;
    expect(scanImports(src)).toEqual(['./a', './b', './c', './d', './e', './side-effect']);
  });

  it('de-duplicates while preserving order', () => {
    expect(scanImports(`import a from './a';\nimport b from './a';`)).toEqual(['./a']);
  });
});

describe('resolveRelative', () => {
  const candidates = new Set([
    'G:/r/src/a.ts',
    'G:/r/src/b.tsx',
    'G:/r/src/c/index.ts',
    'G:/r/src/d.d.ts',
    'G:/r/src/plain.js',
  ]);

  it('probes extensions in TypeScript order', () => {
    expect(resolveRelative('G:/r/src/x.ts', './a', candidates)).toBe('G:/r/src/a.ts');
    expect(resolveRelative('G:/r/src/x.ts', './b', candidates)).toBe('G:/r/src/b.tsx');
    expect(resolveRelative('G:/r/src/x.ts', './d', candidates)).toBe('G:/r/src/d.d.ts');
  });

  it('falls back to a directory index', () => {
    expect(resolveRelative('G:/r/src/x.ts', './c', candidates)).toBe('G:/r/src/c/index.ts');
  });

  // ESM-style TS writes `./a.js` for a file that is really `./a.ts`.
  it('maps a .js specifier onto its TypeScript source', () => {
    expect(resolveRelative('G:/r/src/x.ts', './a.js', candidates)).toBe('G:/r/src/a.ts');
  });

  it('prefers an exact hit over probing', () => {
    expect(resolveRelative('G:/r/src/x.ts', './plain.js', candidates)).toBe('G:/r/src/plain.js');
  });

  it('walks up out of the current directory', () => {
    expect(resolveRelative('G:/r/src/deep/x.ts', '../a', candidates)).toBe('G:/r/src/a.ts');
  });

  // Dependency types are out of the priority wave by design.
  it('ignores bare package specifiers', () => {
    expect(resolveRelative('G:/r/src/x.ts', 'react', candidates)).toBeNull();
    expect(resolveRelative('G:/r/src/x.ts', '@scope/pkg', candidates)).toBeNull();
  });

  it('returns null for a relative path nothing in the project matches', () => {
    expect(resolveRelative('G:/r/src/x.ts', './missing', candidates)).toBeNull();
  });
});

describe('importClosure', () => {
  const files: Record<string, string> = {
    'G:/r/a.ts': `import './b';`,
    'G:/r/b.ts': `import './c';`,
    'G:/r/c.ts': `import './a';`, // cycle
    'G:/r/unrelated.ts': '',
  };
  const candidates = new Set(Object.keys(files));
  const read = async (p: string) => files[p] ?? null;

  it('walks the graph breadth-first from the seed', async () => {
    expect(await importClosure(['G:/r/a.ts'], candidates, read)).toEqual([
      'G:/r/a.ts',
      'G:/r/b.ts',
      'G:/r/c.ts',
    ]);
  });

  it('terminates on a cycle', async () => {
    const out = await importClosure(['G:/r/a.ts'], candidates, read);
    expect(new Set(out).size).toBe(out.length);
    expect(out).not.toContain('G:/r/unrelated.ts');
  });

  it('honours the cap', async () => {
    expect(await importClosure(['G:/r/a.ts'], candidates, read, 2)).toEqual([
      'G:/r/a.ts',
      'G:/r/b.ts',
    ]);
  });

  it('ignores seeds that are not indexable and files it cannot read', async () => {
    expect(await importClosure(['G:/r/nope.ts'], candidates, read)).toEqual([]);
    expect(await importClosure(['G:/r/unrelated.ts'], candidates, async () => null)).toEqual([
      'G:/r/unrelated.ts',
    ]);
  });

  it('accepts a seed given with Windows separators', async () => {
    expect(await importClosure(['G:\\r\\a.ts'], candidates, read, 1)).toEqual(['G:/r/a.ts']);
  });
});
