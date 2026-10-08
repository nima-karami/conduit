import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildImageDiff,
  isBinary,
  langFromPath,
  parseWriteOptions,
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

  it('covers the broadened language set (matching registered Monaco ids)', () => {
    expect(langFromPath('main.go')).toBe('go');
    expect(langFromPath('config.json')).toBe('json');
    expect(langFromPath('lib.rs')).toBe('rust');
    expect(langFromPath('App.kt')).toBe('kotlin');
    expect(langFromPath('script.swift')).toBe('swift');
    expect(langFromPath('infra.tf')).toBe('hcl');
    expect(langFromPath('schema.proto')).toBe('proto');
    expect(langFromPath('Token.sol')).toBe('sol');
    expect(langFromPath('q.graphql')).toBe('graphql');
    expect(langFromPath('deploy.ps1')).toBe('powershell');
    expect(langFromPath('a.unknownext')).toBe('plaintext');
  });

  it('detects language from fixed filenames without an extension', () => {
    expect(langFromPath('repo/Dockerfile')).toBe('dockerfile');
    expect(langFromPath('Containerfile')).toBe('dockerfile');
    expect(langFromPath('project/.bashrc')).toBe('shell');
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
  it('readDir lists entries (dirs first); hides VCS metadata but shows node_modules/build dirs', async () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, '.git')); // VCS metadata — stays hidden
    fs.mkdirSync(path.join(d, 'node_modules')); // editor-standard: shown (read lazily on expand)
    fs.mkdirSync(path.join(d, 'dist')); // build output — shown
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'a.ts'), 'x');
    const entries = await readDir(d);
    expect(entries.map((e) => e.name)).toEqual(['dist', 'node_modules', 'src', 'a.ts']);
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

  it('readFile keeps a UTF-8 BOM in the content', async () => {
    const f = path.join(tmp(), 'bom.txt');
    fs.writeFileSync(f, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
    const doc = await readFile(f);
    expect(doc.content).toBe(`${String.fromCharCode(0xfeff)}a\n`);
    expect(doc.readOnlyReason).toBeUndefined();
  });

  it('readFile marks invalid UTF-8 read-only instead of decoding it to U+FFFD', async () => {
    const f = path.join(tmp(), 'latin1.txt');
    fs.writeFileSync(f, Buffer.from([0x61, 0xe9, 0x62, 0x0a]));
    const doc = await readFile(f);
    expect(doc.readOnlyReason).toBe('invalid-utf8');
    expect(doc.truncated).toBe(false);
  });

  it('readFile marks a mixed-EOL golden read-only, but not a mixed-EOL source file', async () => {
    const d = tmp();
    for (const [name, want] of [
      ['mixed.txt.golden', 'mixed-eol'],
      ['cr.golden', 'mixed-eol'],
      ['mixed.ts', undefined],
    ] as const) {
      const f = path.join(d, name);
      fs.writeFileSync(f, name === 'cr.golden' ? 'a\rb\nc\n' : 'a\r\nb\nc\r\n');
      expect((await readFile(f)).readOnlyReason, name).toBe(want);
    }
    for (const body of ['a\r\nb\r\n', 'a\nb\n', 'a\rb\r', 'no newline']) {
      const f = path.join(d, 'pure.txt.golden');
      fs.writeFileSync(f, body);
      expect((await readFile(f)).readOnlyReason, JSON.stringify(body)).toBeUndefined();
    }
  });

  it('readDiff combines working file + injected HEAD content', async () => {
    const d = tmp();
    const f = path.join(d, 'x.ts');
    fs.writeFileSync(f, 'new');
    const diff = await readDiff(f, async () => 'old');
    expect(diff).toMatchObject({ work: 'new', head: 'old', binary: false });
  });

  it('readDiff normalizes a CRLF working file to LF so the Monaco diff matches LF HEAD', async () => {
    const d = tmp();
    const f = path.join(d, 'crlf.ts');
    fs.writeFileSync(f, 'a\r\nB\r\nc\r\n');
    const diff = await readDiff(f, async () => 'a\nb\nc\n');
    expect(diff.work).toBe('a\nB\nc\n');
    expect(diff.head).toBe('a\nb\nc\n');
  });
});

describe('fileService readFile over the cap (spec 2026-10-08-language-support §2.5)', () => {
  const lines = (from: number, to: number) => {
    let s = '';
    for (let i = from; i <= to; i++) s += `line ${String(i).padStart(4, '0')}\n`;
    return s;
  };
  // 10 bytes per line; a 64-byte cap is 6.4 lines.
  const CAP = 64;
  const body = lines(1, 50);

  afterEach(() => vi.restoreAllMocks());

  it('reads only the head window of a non-log file, never the whole file', async () => {
    const f = path.join(tmp(), 'big.txt');
    fs.writeFileSync(f, body);
    const whole = vi.spyOn(fs.promises, 'readFile');
    const doc = await readFile(f, CAP);
    expect(whole).not.toHaveBeenCalled();
    expect(doc.content).toBe(body.slice(0, CAP));
    expect(doc).toMatchObject({ truncated: true, binary: false, language: 'plaintext' });
    expect(doc.window).toBeUndefined();
  });

  it('reads the tail window of a log, starting on a whole line', async () => {
    const f = path.join(tmp(), 'big.log');
    fs.writeFileSync(f, body);
    const whole = vi.spyOn(fs.promises, 'readFile');
    const doc = await readFile(f, CAP);
    expect(whole).not.toHaveBeenCalled();
    const tail = body.slice(body.length - CAP);
    expect(doc.content).toBe(tail.slice(tail.indexOf('\n') + 1));
    expect(doc.content.startsWith('line ')).toBe(true);
    expect(doc.content.endsWith('line 0050\n')).toBe(true);
    expect(doc).toMatchObject({ truncated: true, window: 'tail', language: 'log' });
  });

  it('cuts a tail window that starts mid-CRLF and keeps one with no newline as-is', async () => {
    const d = tmp();
    const crlf = path.join(d, 'crlf.log');
    fs.writeFileSync(crlf, `${'x'.repeat(CAP - 1)}\r\nlast\r\n`);
    expect((await readFile(crlf, CAP)).content).toBe('last\r\n');
    const flat = path.join(d, 'flat.log');
    fs.writeFileSync(flat, 'y'.repeat(CAP * 2));
    expect((await readFile(flat, CAP)).content).toBe('y'.repeat(CAP));
  });

  it('never starts a tail window inside a multi-byte character', async () => {
    const f = path.join(tmp(), 'utf8.log');
    fs.writeFileSync(f, `${'é'.repeat(CAP)}\nend\n`);
    const doc = await readFile(f, CAP);
    expect(doc.content).toBe('end\n');
  });

  it('sniffs binary on the window it read', async () => {
    const f = path.join(tmp(), 'nul.log');
    fs.writeFileSync(f, Buffer.concat([Buffer.from(body), Buffer.from([0, 1, 2, 0x0a])]));
    const doc = await readFile(f, CAP);
    expect(doc.binary).toBe(true);
    expect(doc.content).toBe('');
  });

  it('reads a file at the cap whole, in one read, with no window', async () => {
    const f = path.join(tmp(), 'exact.log');
    fs.writeFileSync(f, body.slice(0, CAP));
    const doc = await readFile(f, CAP);
    expect(doc).toMatchObject({ content: body.slice(0, CAP), truncated: false });
    expect(doc.window).toBeUndefined();
  });
});

describe('fileService image diff (status + over-cap decision)', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG signature bytes
  const PNG2 = Buffer.from('89504e470d0a1a0aDEAD', 'hex');

  it('both sides present ⇒ modified, with both data URLs', () => {
    const d = buildImageDiff('a/icon.png', PNG2, PNG);
    expect(d.image?.status).toBe('modified');
    expect(d.binary).toBe(true);
    expect(d.image?.head?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(d.image?.work?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(d.image?.head?.bytes).toBe(PNG.length);
    expect(d.image?.overCap).toBeUndefined();
  });

  it('missing HEAD ⇒ added (only work side)', () => {
    const d = buildImageDiff('a/new.png', PNG, null);
    expect(d.image?.status).toBe('added');
    expect(d.image?.head).toBeUndefined();
    expect(d.image?.work).toBeDefined();
  });

  it('missing working file ⇒ deleted (only head side)', () => {
    const d = buildImageDiff('a/gone.png', null, PNG);
    expect(d.image?.status).toBe('deleted');
    expect(d.image?.work).toBeUndefined();
    expect(d.image?.head).toBeDefined();
  });

  it('either side over the 25 MB cap ⇒ overCap, no data URLs (degrade to notice)', () => {
    const huge = Buffer.alloc(26 * 1024 * 1024);
    const over = buildImageDiff('a/big.png', huge, PNG);
    expect(over.image?.overCap).toBe(true);
    expect(over.image?.head).toBeUndefined();
    expect(over.image?.work).toBeUndefined();
    expect(over.binary).toBe(true);
  });

  it('readDiff routes image paths through the buffer reader (added when no HEAD)', async () => {
    const dir = tmp();
    const f = path.join(dir, 'pic.png');
    fs.writeFileSync(f, PNG);
    const diff = await readDiff(
      f,
      async () => '',
      async () => null, // no HEAD blob ⇒ added
    );
    expect(diff.binary).toBe(true);
    expect(diff.image?.status).toBe('added');
    expect(diff.image?.work?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('readDiff round-trips the HEAD buffer byte-identically', async () => {
    const dir = tmp();
    const f = path.join(dir, 'pic.png');
    fs.writeFileSync(f, PNG2);
    const diff = await readDiff(
      f,
      async () => '',
      async () => PNG,
    );
    const headB64 = diff.image?.head?.dataUrl.split(',')[1] ?? '';
    expect(Buffer.from(headB64, 'base64').equals(PNG)).toBe(true);
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

  it('recreates the folders of a file whose folder was deleted under it', async () => {
    const root = fs.realpathSync.native(tmp());
    const f = path.join(root, 'gone', 'deep', 'c.ts');
    const res = await writeFile(f, 'kept', [root]);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('kept');
  });

  it('never creates a folder outside the root', async () => {
    const root = fs.realpathSync.native(tmp());
    const outside = path.join(fs.realpathSync.native(tmp()), 'made');
    const res = await writeFile(path.join(outside, 'x.ts'), 'x', [root]);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('never recreates a deleted workspace root (or anything above it)', async () => {
    const parent = fs.realpathSync.native(tmp());
    const root = path.join(parent, 'gone-root');
    const res = await writeFile(path.join(root, 'sub', 'x.ts'), 'x', [root]);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('never follows a symlinked folder out of the root to create folders there', async () => {
    const root = fs.realpathSync.native(tmp());
    const outside = fs.realpathSync.native(tmp());
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    const res = await writeFile(path.join(root, 'link', 'new', 'deep', 'x.ts'), 'x', [root]);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
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

  it('a granted file whose folder was deleted is not written, and no folder is created', async () => {
    const root = fs.realpathSync.native(tmp());
    const outside = fs.realpathSync.native(tmp());
    const dir = path.join(outside, 'pkg');
    fs.mkdirSync(dir);
    const f = path.join(dir, 'granted.ts');
    fs.writeFileSync(f, 'x');
    const grants = createGrantStore({ canonical: hostCanonical });
    grants.add(f);
    fs.rmSync(dir, { recursive: true });
    const res = await writeFile(f, 'again', [root], grants);
    expect(res.ok).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
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

describe('fileService writeFile (auto-save precondition)', () => {
  const setup = (content: string) => {
    const root = fs.realpathSync.native(tmp());
    const f = path.join(root, 'a.ts');
    fs.writeFileSync(f, content);
    return { root, f };
  };

  it('writes when expected equals disk', async () => {
    const { root, f } = setup('one');
    const res = await writeFile(f, 'two', [root], undefined, { expected: 'one' });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('two');
  });

  it('refuses with conflict changed when disk differs', async () => {
    const { root, f } = setup('theirs');
    const res = await writeFile(f, 'mine', [root], undefined, { expected: 'one' });
    expect(res).toEqual({ ok: false, conflict: 'changed', error: 'The file changed on disk.' });
    expect(fs.readFileSync(f, 'utf8')).toBe('theirs');
  });

  it('refuses with conflict deleted when the target is missing', async () => {
    const root = fs.realpathSync.native(tmp());
    const f = path.join(root, 'gone.ts');
    const res = await writeFile(f, 'mine', [root], undefined, { expected: 'one' });
    expect(res).toEqual({ ok: false, conflict: 'deleted', error: 'The file was deleted on disk.' });
    expect(fs.existsSync(f)).toBe(false);
  });

  it('compares a BOM file as decoded utf8', async () => {
    const BOM = '\uFEFF';
    const { root, f } = setup(`${BOM}x`);
    const res = await writeFile(f, `${BOM}y`, [root], undefined, { expected: `${BOM}x` });
    expect(res.ok).toBe(true);
  });

  it('compares beyond the 2 MB read cap', async () => {
    const full = 'x'.repeat(2.5 * 1024 * 1024);
    const { root, f } = setup(full);
    const cut = full.slice(0, 2 * 1024 * 1024);
    const refused = await writeFile(f, 'mine', [root], undefined, { expected: cut });
    expect(refused.ok === false && refused.conflict).toBe('changed');
    const res = await writeFile(f, 'mine', [root], undefined, { expected: full });
    expect(res.ok).toBe(true);
  });

  it('path escape is still rejected before any compare', async () => {
    const root = fs.realpathSync.native(tmp());
    const sibling = fs.realpathSync.native(tmp());
    fs.writeFileSync(path.join(sibling, 'victim.ts'), 'untouched');
    const escapePath = path.join(root, '..', path.basename(sibling), 'victim.ts');
    const without = await writeFile(escapePath, 'HACKED', [root]);
    const withExpected = await writeFile(escapePath, 'HACKED', [root], undefined, {
      expected: 'untouched',
    });
    expect(withExpected).toEqual(without);
    expect('conflict' in withExpected).toBe(false);
    expect(fs.readFileSync(path.join(sibling, 'victim.ts'), 'utf8')).toBe('untouched');
  });

  it('absent expected keeps unconditional overwrite', async () => {
    const { root, f } = setup('theirs');
    const res = await writeFile(f, 'mine', [root]);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('mine');
  });

  it('granted missing file with expected is deleted, not recreated', async () => {
    const root = fs.realpathSync.native(tmp());
    const outside = fs.realpathSync.native(tmp());
    const f = path.join(outside, 'granted.ts');
    fs.writeFileSync(f, 'one');
    const grants = createGrantStore({ canonical: hostCanonical });
    grants.add(f);
    fs.rmSync(f);
    const res = await writeFile(f, 'mine', [root], grants, { expected: 'one' });
    expect(res.ok === false && res.conflict).toBe('deleted');
    expect(fs.existsSync(f)).toBe(false);
  });
});

describe('parseWriteOptions (IPC trust boundary)', () => {
  it('accepts absent or string expected and rejects everything else', () => {
    expect(parseWriteOptions(undefined)).toEqual({});
    expect(parseWriteOptions({})).toEqual({});
    expect(parseWriteOptions({ expected: 'a' })).toEqual({ expected: 'a' });
    expect(parseWriteOptions({ expected: 1 })).toBeNull();
    expect(parseWriteOptions(null)).toBeNull();
    expect(parseWriteOptions([])).toBeNull();
    expect(parseWriteOptions('x')).toBeNull();
  });
});
