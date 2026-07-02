import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexToSearchHits, SEARCH_IGNORE, walkFiles } from '../../src/file-search';
import type { IndexedFile } from '../../src/path-resolve';

function tmpTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsearch-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '#');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'x');
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'y');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'bloat.js'), 'z');
  return root;
}

describe('walkFiles', () => {
  it('lists files recursively with forward-slash rel paths', () => {
    const root = tmpTree();
    const rels = walkFiles(root)
      .map((h) => h.rel)
      .sort();
    expect(rels).toContain('README.md');
    expect(rels).toContain('src/index.ts');
    expect(rels).toContain('src/util.ts');
  });

  it('skips ignored directories like node_modules', () => {
    const root = tmpTree();
    const rels = walkFiles(root).map((h) => h.rel);
    expect(rels.some((r) => r.includes('node_modules'))).toBe(false);
    expect(SEARCH_IGNORE.has('node_modules')).toBe(true);
  });

  it('respects the cap', () => {
    const root = tmpTree();
    expect(walkFiles(root, 2).length).toBe(2);
  });

  it('returns absolute paths that exist', () => {
    const root = tmpTree();
    for (const h of walkFiles(root)) expect(fs.existsSync(h.abs)).toBe(true);
  });
});

describe('indexToSearchHits', () => {
  it('keeps rel forward-slash and rebuilds abs with native separators', () => {
    const index: IndexedFile[] = [
      { rel: 'src/index.ts', abs: '/repo/src/index.ts' },
      { rel: 'README.md', abs: '/repo/README.md' },
    ];
    const hits = indexToSearchHits(index, path.join('/repo'));
    expect(hits.map((h) => h.rel)).toEqual(['src/index.ts', 'README.md']);
    expect(hits[0].abs).toBe(path.join('/repo', 'src', 'index.ts'));
    expect(hits[1].abs).toBe(path.join('/repo', 'README.md'));
  });

  it('matches walkFiles abs paths for the same tree (parity with the BFS walk)', () => {
    const root = tmpTree();
    const walked = walkFiles(root)
      .map((h) => h.abs)
      .sort();
    const index: IndexedFile[] = walkFiles(root).map((h) => ({
      rel: h.rel,
      abs: h.abs.replace(/\\/g, '/'),
    }));
    const adapted = indexToSearchHits(index, root)
      .map((h) => h.abs)
      .sort();
    expect(adapted).toEqual(walked);
  });
});
