import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitIgnoredNames, gitListedFiles, parseTaggedListing } from '../../src/git-listing';

// Without -z git C-quotes these names under the default core.quotePath, and the quoted form
// names no file: quick-open and search lost them, and the Explorer never dimmed them.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const CAFE = `caf${cp(0xe9)}.txt`;
const CJK = `${cp(0x65e5, 0x672c)}.txt`;
const IGNORED = `ign${cp(0xf6)}red.log`;
const SPACED = 'with space.txt';

describe('gitListedFiles / gitIgnoredNames on real git', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-git-listing-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'core.quotePath', 'true');
    fs.writeFileSync(path.join(root, '.gitignore'), `${IGNORED}\n`);
    for (const n of [CAFE, CJK, SPACED, IGNORED]) fs.writeFileSync(path.join(root, n), 'x\n');
    git('add', CAFE);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists tracked and untracked names verbatim, leaving the ignored one out', async () => {
    expect(await gitListedFiles(root)).toEqual({
      kind: 'listed',
      rels: expect.arrayContaining(['.gitignore', CAFE, CJK, SPACED]),
    });
    const listing = await gitListedFiles(root);
    expect(listing.kind === 'listed' && listing.rels.length).toBe(4);
  });

  it('reports an ignored non-ASCII name as the name it was given', async () => {
    expect(await gitIgnoredNames(root, [CAFE, IGNORED, SPACED])).toEqual(new Set([IGNORED]));
  });
});

describe('gitListedFiles: what a listing leaves out, and when git did not answer', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-git-listing-del-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    for (const n of ['kept.ts', 'gone.ts', 'unstaged-rm.ts'])
      fs.writeFileSync(path.join(root, n), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    git('rm', '-q', 'gone.ts');
    fs.rmSync(path.join(root, 'unstaged-rm.ts'));
    fs.writeFileSync(path.join(root, 'new.ts'), 'x\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a tracked file deleted from the worktree but not staged is not listed', async () => {
    const listing = await gitListedFiles(root);
    expect(listing.kind).toBe('listed');
    if (listing.kind === 'listed') expect(listing.rels.sort()).toEqual(['kept.ts', 'new.ts']);
  });

  it('a folder in no repo is not-repo; a vanished folder is a failure, not an empty repo', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-git-listing-plain-'));
    try {
      expect(await gitListedFiles(plain)).toEqual({ kind: 'not-repo' });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    expect(await gitListedFiles(path.join(root, 'no-such-dir'))).toEqual({ kind: 'failed' });
  });
});

describe('parseTaggedListing', () => {
  it('drops R records and dedupes per-stage records', () => {
    const out = ['H a.ts', 'H b.ts', 'R b.ts', 'M c.ts', 'M c.ts', 'M c.ts', '? d.ts', ''].join(
      '\0',
    );
    expect(parseTaggedListing(out)).toEqual(['a.ts', 'c.ts', 'd.ts']);
  });
});
