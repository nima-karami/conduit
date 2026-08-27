import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../../src/protocol';
import {
  INDEX_FILE_CAP,
  INDEX_MAX_FILE_BYTES,
  isOversizedForIndex,
  newIndexPaths,
  selectIndexCandidates,
  selectIndexHits,
  TOOL_STATE_DIRS,
} from '../../src/source-index';

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
  it('drops files under a named tool-state directory at any depth', () => {
    const out = selectIndexHits([
      hit('webview/shortcuts.ts'),
      hit('.claude/worktrees/parity/webview/shortcuts.ts'),
      hit('.autoloop/preview/harness.ts'),
      hit('packages/app/.next/types/gen.ts'),
      hit('.yarn/releases/yarn.cjs'),
      hit('src/dot.name/keep.ts'),
      hit('.eslintrc.js'), // a dotFILE at the root is still the project's own
    ]);
    expect(out.map((h) => h.rel)).toEqual([
      '.eslintrc.js',
      'src/dot.name/keep.ts',
      'webview/shortcuts.ts',
    ]);
  });

  // The old rule dropped ANY dot-directory, which is the row-15 bug: these hold first-party
  // TypeScript. See docs/specs/2026-08-21-goto-definition-flows.md contract 5.
  it('keeps dot-directories that are NOT tool state', () => {
    const out = selectIndexHits([
      hit('.storybook/types.ts'),
      hit('.config/build.ts'),
      hit('.github/scripts/release.ts'),
      hit('.vscode/extension.ts'),
      hit('src/app.ts'),
    ]);
    expect(out.map((h) => h.rel)).toEqual([
      '.config/build.ts',
      '.github/scripts/release.ts',
      '.storybook/types.ts',
      '.vscode/extension.ts',
      'src/app.ts',
    ]);
  });

  it('does not list a dot-dir that can hold real sources as tool state', () => {
    for (const dir of ['.storybook', '.config', '.github', '.vscode']) {
      expect(TOOL_STATE_DIRS.has(dir)).toBe(false);
    }
    expect(TOOL_STATE_DIRS.has('.git')).toBe(true);
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

describe('selectIndexCandidates', () => {
  it('is the same selection WITHOUT the cap, so the caller can count what the cap dropped', () => {
    const many = Array.from({ length: 50 }, (_, i) => hit(`f${String(i).padStart(3, '0')}.ts`));
    const all = selectIndexCandidates([...many, hit('readme.md'), hit('.git/hooks/x.js')]);
    expect(all).toHaveLength(50);
    expect(all.slice(0, 3)).toEqual(selectIndexHits(many, 3));
  });
});

describe('newIndexPaths', () => {
  it('streams only what this root has not sent yet — row 35', () => {
    const sent = new Set(['/r/a.ts', '/r/b.ts']);
    expect(newIndexPaths(['/r/a.ts', '/r/b.ts', '/r/late.ts'], sent)).toEqual(['/r/late.ts']);
  });

  it('is empty when nothing appeared, so a quiet fsChanged costs no message', () => {
    expect(newIndexPaths(['/r/a.ts'], new Set(['/r/a.ts']))).toEqual([]);
  });

  it('leaves a deleted file’s entry alone (deletions are not part of this pass)', () => {
    expect(newIndexPaths(['/r/a.ts'], new Set(['/r/a.ts', '/r/gone.ts']))).toEqual([]);
  });
});

describe('isOversizedForIndex', () => {
  // A truncated file in extraLibs is worse than an absent one: the worker holds half a file
  // and confidently denies every symbol past the cut (row 17).
  it('skips only files past the read cap', () => {
    expect(isOversizedForIndex(0)).toBe(false);
    expect(isOversizedForIndex(INDEX_MAX_FILE_BYTES)).toBe(false);
    expect(isOversizedForIndex(INDEX_MAX_FILE_BYTES + 1)).toBe(true);
  });

  it('matches the file-service read cap it exists to stay ahead of', () => {
    expect(INDEX_MAX_FILE_BYTES).toBe(2 * 1024 * 1024);
  });
});
