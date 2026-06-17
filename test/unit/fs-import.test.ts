import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsImport, uniqueDestPath } from '../../src/fs-import';

describe('uniqueDestPath', () => {
  it('returns the plain path when nothing collides', () => {
    expect(uniqueDestPath('/d', 'a.txt', () => false)).toBe(join('/d', 'a.txt'));
  });

  it('suffixes "(n)" before the extension on collision', () => {
    const taken = new Set([join('/d', 'a.txt'), join('/d', 'a (1).txt')]);
    expect(uniqueDestPath('/d', 'a.txt', (p) => taken.has(p))).toBe(join('/d', 'a (2).txt'));
  });

  it('treats a leading-dot dotfile as having no extension', () => {
    const taken = new Set([join('/d', '.env')]);
    expect(uniqueDestPath('/d', '.env', (p) => taken.has(p))).toBe(join('/d', '.env (1)'));
  });

  it('suffixes a folder name (no extension)', () => {
    const taken = new Set([join('/d', 'sub')]);
    expect(uniqueDestPath('/d', 'sub', (p) => taken.has(p))).toBe(join('/d', 'sub (1)'));
  });
});

describe('fsImport', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conduit-imp-root-'));
    outside = mkdtempSync(join(tmpdir(), 'conduit-imp-src-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('copies an external file into a target dir inside a root', async () => {
    const src = join(outside, 'note.txt');
    writeFileSync(src, 'hello');
    const res = await fsImport([src], root, [root]);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hello');
    // The original is left untouched (copy, never move).
    expect(readFileSync(src, 'utf8')).toBe('hello');
  });

  it('de-dupes the name instead of clobbering an existing file', async () => {
    writeFileSync(join(root, 'note.txt'), 'original');
    const src = join(outside, 'note.txt');
    writeFileSync(src, 'incoming');
    const res = await fsImport([src], root, [root]);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('original');
    expect(readFileSync(join(root, 'note (1).txt'), 'utf8')).toBe('incoming');
  });

  it('copies a folder recursively', async () => {
    const dir = join(outside, 'pkg');
    writeFileSync(join(mkdtempSync(join(outside, 'x-')), 'ignore'), '');
    require('node:fs').mkdirSync(dir);
    writeFileSync(join(dir, 'a.ts'), 'A');
    const res = await fsImport([dir], root, [root]);
    expect(res.ok).toBe(true);
    expect(readdirSync(join(root, 'pkg'))).toContain('a.ts');
  });

  it('refuses to import outside any workspace root', async () => {
    const src = join(outside, 'note.txt');
    writeFileSync(src, 'x');
    const res = await fsImport([src], outside, [root]); // target outside the root
    expect(res.ok).toBe(false);
  });

  it('errors when there is no open workspace', async () => {
    const res = await fsImport([join(outside, 'a')], root, []);
    expect(res.ok).toBe(false);
  });
});
