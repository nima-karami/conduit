import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkFiles, SEARCH_IGNORE } from '../../src/fileSearch';

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
    const rels = walkFiles(root).map((h) => h.rel).sort();
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
