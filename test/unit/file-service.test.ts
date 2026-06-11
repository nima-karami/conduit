import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isBinary,
  langFromPath,
  readDiff,
  readDir,
  readFile,
  sortEntries,
  writeFile,
} from '../../src/file-service';
import type { DirEntryDTO } from '../../src/protocol';
import { createGrantStore, hostCanonical } from '../../src/read-grants';

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
    expect(doc).toMatchObject({
      content: 'const a = 1;',
      language: 'typescript',
      binary: false,
      truncated: false,
    });
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

describe('fileService writeFile (host write path + confinement)', () => {
  it('writes a file that is inside the workspace root', async () => {
    const root = fs.realpathSync.native(tmp());
    const f = path.join(root, 'src', 'edited.ts');
    fs.mkdirSync(path.dirname(f));
    fs.writeFileSync(f, 'const a = 1;');
    const res = await writeFile(f, 'const a = 2;', [root]);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('const a = 2;');
  });

  it('REJECTS a ".." escape and does NOT write outside the root', async () => {
    const root = fs.realpathSync.native(tmp());
    const sibling = fs.realpathSync.native(tmp());
    const victim = path.join(sibling, 'victim.ts');
    fs.writeFileSync(victim, 'untouched');
    // A path that escapes `root` up into the sibling dir.
    const escapePath = path.join(root, '..', path.basename(sibling), 'victim.ts');
    const res = await writeFile(escapePath, 'HACKED', [root]);
    expect(res.ok).toBe(false);
    // The victim file must be byte-for-byte unchanged.
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('does not leave a temp file behind on a successful write', async () => {
    const root = fs.realpathSync.native(tmp());
    const f = path.join(root, 'x.ts');
    fs.writeFileSync(f, 'old');
    await writeFile(f, 'new', [root]);
    const leftovers = fs.readdirSync(root).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('fileService writeFile (K2 read-grant allowance)', () => {
  // The grant store records exact files the host served via readFile. Use the real
  // host canonicalizer so the read→write key comparison matches production.
  it('ALLOWS a write to an out-of-root file that the host granted (read first)', async () => {
    const root = fs.realpathSync.native(tmp());
    const outside = fs.realpathSync.native(tmp()); // a real dir, NOT a write root
    const f = path.join(outside, 'gotodef.ts');
    fs.writeFileSync(f, 'const a = 1;');
    const grants = createGrantStore({ canonical: hostCanonical });
    grants.add(f); // host served it via readFile
    const res = await writeFile(f, 'const a = 2;', [root], grants);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('const a = 2;');
  });

  it('STILL REJECTS an out-of-root file that was never granted', async () => {
    const root = fs.realpathSync.native(tmp());
    const outside = fs.realpathSync.native(tmp());
    const f = path.join(outside, 'ungranted.ts');
    fs.writeFileSync(f, 'untouched');
    const grants = createGrantStore({ canonical: hostCanonical });
    const res = await writeFile(f, 'HACKED', [root], grants);
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(f, 'utf8')).toBe('untouched');
  });

  it('the root check still wins first — a rooted write needs no grant', async () => {
    const root = fs.realpathSync.native(tmp());
    const f = path.join(root, 'in-root.ts');
    fs.writeFileSync(f, 'old');
    const grants = createGrantStore({ canonical: hostCanonical }); // empty
    const res = await writeFile(f, 'new', [root], grants);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('new');
  });

  it('REFUSES to write over a directory even when its path is granted', async () => {
    const root = fs.realpathSync.native(tmp());
    const outside = fs.realpathSync.native(tmp());
    const dir = path.join(outside, 'adir');
    fs.mkdirSync(dir);
    const grants = createGrantStore({ canonical: hostCanonical });
    grants.add(dir);
    const res = await writeFile(dir, 'x', [root], grants);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/directory/i);
  });
});
