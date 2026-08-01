import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../../src/protocol';
import { INDEX_FILE_CAP, selectIndexHits } from '../../src/source-index';

const hit = (rel: string): SearchHit => ({ rel, abs: `/root/${rel}` });

describe('selectIndexHits', () => {
  it('keeps only JS/TS source files', () => {
    const out = selectIndexHits([
      hit('a.ts'),
      hit('b.tsx'),
      hit('c.js'),
      hit('d.mjs'),
      hit('readme.md'),
      hit('style.css'),
      hit('data.json'),
      hit('img.png'),
    ]);
    expect(out.map((h) => h.rel)).toEqual(['a.ts', 'b.tsx', 'c.js', 'd.mjs']);
  });

  // A worktree under .claude/worktrees is a second copy of the whole checkout: indexing it
  // doubles the model count and lets go-to-definition resolve into the stale copy.
  it('drops files under a tool-state (dot) directory at any depth', () => {
    const out = selectIndexHits([
      hit('webview/shortcuts.ts'),
      hit('.claude/worktrees/parity/webview/shortcuts.ts'),
      hit('.autoloop/preview/harness.ts'),
      hit('src/.generated/gen.ts'),
      hit('src/dot.name/keep.ts'),
      hit('.eslintrc.js'), // a dotFILE at the root is still the project's own
    ]);
    expect(out.map((h) => h.rel)).toEqual([
      '.eslintrc.js',
      'src/dot.name/keep.ts',
      'webview/shortcuts.ts',
    ]);
  });

  it('sorts deterministically by rel so coverage is stable across walk order', () => {
    const out = selectIndexHits([hit('z/last.ts'), hit('a/first.ts'), hit('m/mid.ts')]);
    expect(out.map((h) => h.rel)).toEqual(['a/first.ts', 'm/mid.ts', 'z/last.ts']);
  });

  it('caps the result (the prior 400 cap silently dropped this repo’s tail)', () => {
    const many = Array.from({ length: 50 }, (_, i) => hit(`f${String(i).padStart(3, '0')}.ts`));
    expect(selectIndexHits(many, 10)).toHaveLength(10);
    // The cap takes the deterministic-sorted head, not an arbitrary slice.
    expect(selectIndexHits(many, 3).map((h) => h.rel)).toEqual(['f000.ts', 'f001.ts', 'f002.ts']);
  });

  it('defaults to a generous cap that covers a typical project', () => {
    expect(INDEX_FILE_CAP).toBeGreaterThanOrEqual(1000);
  });
});
