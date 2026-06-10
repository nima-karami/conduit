import { describe, it, expect } from 'vitest';
import { langFromPath, isBinary, sortEntries } from '../../src/fileService';
import type { DirEntryDTO } from '../../src/protocol';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDir, readFile, readDiff } from '../../src/fileService';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsvc-'));
}

describe('fileService helpers', () => {
  it('infers Monaco language ids from extension', () => {
    expect(langFromPath('a/b.ts')).toBe('typescript');
    expect(langFromPath('x.TSX')).toBe('typescript');
    expect(langFromPath('readme.md')).toBe('markdown');
    expect(langFromPath('Makefile')).toBe('plaintext');
  });

  it('detects binary content via NUL bytes', () => {
    expect(isBinary(Buffer.from('hello world'))).toBe(false);
    expect(isBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('sorts directories first, then by name (case-insensitive)', () => {
    const input: DirEntryDTO[] = [
      { name: 'b.ts', kind: 'file' },
      { name: 'src', kind: 'dir' },
      { name: 'A.ts', kind: 'file' },
      { name: 'lib', kind: 'dir' },
    ];
    expect(sortEntries(input).map((e) => e.name)).toEqual(['lib', 'src', 'A.ts', 'b.ts']);
  });
});

describe('fileService readers', () => {
  it('readDir lists entries (dirs first) and skips ignored', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'a.ts'), 'x');
    const entries = await readDir(d);
    expect(entries.map((e) => e.name)).toEqual(['src', 'a.ts']);
  });

  it('readFile returns content + language', async () => {
    const d = tmp();
    const f = path.join(d, 'x.ts');
    fs.writeFileSync(f, 'const a = 1;');
    const doc = await readFile(f);
    expect(doc).toMatchObject({ content: 'const a = 1;', language: 'typescript', binary: false, truncated: false });
  });

  it('readFile flags binary files', async () => {
    const d = tmp();
    const f = path.join(d, 'b.bin');
    fs.writeFileSync(f, Buffer.from([1, 0, 2]));
    const doc = await readFile(f);
    expect(doc.binary).toBe(true);
    expect(doc.content).toBe('');
  });

  it('readDiff combines working file + injected HEAD content', async () => {
    const d = tmp();
    const f = path.join(d, 'x.ts');
    fs.writeFileSync(f, 'new');
    const diff = await readDiff(f, async () => 'old');
    expect(diff).toMatchObject({ work: 'new', head: 'old', binary: false });
  });
});
