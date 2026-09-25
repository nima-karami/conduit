import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_OUTGOING_PATHS,
  nodeOutgoingPathDeps,
  type OutgoingFolders,
  type OutgoingPathDeps,
  outgoingFoldersFor,
  validateOutgoingPaths,
} from '../../src/outgoing-paths';

const folders: OutgoingFolders = { present: ['/w/home', '/w/extra'], missing: ['/w/gone'] };

function fakeDeps(existing: string[], over: Partial<OutgoingPathDeps> = {}): OutgoingPathDeps {
  const set = new Set(existing);
  return { realpath: (p) => p, exists: (p) => set.has(p), caseInsensitive: false, ...over };
}

describe('validateOutgoingPaths', () => {
  it('non-array / empty / non-string → bad-request', () => {
    const d = fakeDeps(['/w/home/a']);
    expect(validateOutgoingPaths('/w/home/a', folders, d)).toEqual({
      ok: false,
      reason: 'bad-request',
    });
    expect(validateOutgoingPaths([], folders, d)).toEqual({ ok: false, reason: 'bad-request' });
    expect(validateOutgoingPaths(['/w/home/a', 3], folders, d)).toEqual({
      ok: false,
      reason: 'bad-request',
    });
  });

  it('501 entries → too-many before any stat', () => {
    const exists = vi.fn(() => true);
    const realpath = vi.fn((p: string) => p);
    const paths = Array.from({ length: MAX_OUTGOING_PATHS + 1 }, (_, i) => `/w/home/f${i}`);
    expect(
      validateOutgoingPaths(paths, folders, { exists, realpath, caseInsensitive: false }),
    ).toEqual({ ok: false, reason: 'too-many' });
    expect(exists).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it('exactly the maximum is accepted', () => {
    const paths = Array.from({ length: MAX_OUTGOING_PATHS }, (_, i) => `/w/home/f${i}`);
    const v = validateOutgoingPaths(paths, folders, fakeDeps(paths));
    expect(v.ok && v.paths.length).toBe(MAX_OUTGOING_PATHS);
  });

  it('relative → bad-request with path', () => {
    expect(validateOutgoingPaths(['a/b.txt'], folders, fakeDeps([]))).toEqual({
      ok: false,
      reason: 'bad-request',
      path: 'a/b.txt',
    });
  });

  it('outside → outside-folders with path', () => {
    expect(validateOutgoingPaths(['/etc/passwd'], folders, fakeDeps(['/etc/passwd']))).toEqual({
      ok: false,
      reason: 'outside-folders',
      path: '/etc/passwd',
    });
  });

  it('a sibling whose name extends a folder is outside', () => {
    const v = validateOutgoingPaths(['/w/home-evil/x'], folders, fakeDeps(['/w/home-evil/x']));
    expect(v).toMatchObject({ ok: false, reason: 'outside-folders' });
  });

  it('under a missing root → folder-missing', () => {
    expect(validateOutgoingPaths(['/w/gone/x'], folders, fakeDeps(['/w/gone/x']))).toEqual({
      ok: false,
      reason: 'folder-missing',
      path: '/w/gone/x',
    });
  });

  it('realpath outside → symlink-escape', () => {
    const d = fakeDeps(['/w/home/link'], {
      realpath: (p) => (p === '/w/home/link' ? '/etc' : p),
    });
    expect(validateOutgoingPaths(['/w/home/link'], folders, d)).toEqual({
      ok: false,
      reason: 'symlink-escape',
      path: '/w/home/link',
    });
  });

  it('home reached through a junction is allowed', () => {
    const map: Record<string, string> = { '/w/home': '/real/home', '/w/home/a': '/real/home/a' };
    const d = fakeDeps(['/w/home/a'], { realpath: (p) => map[p] ?? p });
    expect(validateOutgoingPaths(['/w/home/a'], folders, d)).toEqual({
      ok: true,
      paths: ['/w/home/a'],
    });
  });

  it('nonexistent → missing', () => {
    expect(validateOutgoingPaths(['/w/home/nope'], folders, fakeDeps([]))).toEqual({
      ok: false,
      reason: 'missing',
      path: '/w/home/nope',
    });
  });

  it('caseInsensitive dedupe keeps one, the first spelling', () => {
    const d = fakeDeps(['/w/home/A.txt', '/w/home/a.txt'], { caseInsensitive: true });
    expect(validateOutgoingPaths(['/w/home/A.txt', '/w/home/a.txt'], folders, d)).toEqual({
      ok: true,
      paths: ['/w/home/A.txt'],
    });
  });

  it('case-sensitive keeps both spellings', () => {
    const d = fakeDeps(['/w/home/A.txt', '/w/home/a.txt']);
    const v = validateOutgoingPaths(['/w/home/A.txt', '/w/home/a.txt'], folders, d);
    expect(v.ok && v.paths).toEqual(['/w/home/A.txt', '/w/home/a.txt']);
  });

  it('top-level reduction', () => {
    const d = fakeDeps(['/w/home/d', '/w/home/d/x']);
    expect(validateOutgoingPaths(['/w/home/d', '/w/home/d/x'], folders, d)).toEqual({
      ok: true,
      paths: ['/w/home/d'],
    });
  });

  it('one bad path refuses the whole request', () => {
    const v = validateOutgoingPaths(
      ['/w/home/a', '/w/extra/b', '/etc/hosts'],
      folders,
      fakeDeps(['/w/home/a', '/w/extra/b', '/etc/hosts']),
    );
    expect(v).toEqual({ ok: false, reason: 'outside-folders', path: '/etc/hosts' });
  });
});

describe('outgoingFoldersFor', () => {
  it('home missing → home in missing, not present', () => {
    expect(outgoingFoldersFor({ home: '/h', roots: ['/r'], homeMissing: true })).toEqual({
      present: ['/r'],
      missing: ['/h'],
    });
  });

  it('missingRoots are excluded from present', () => {
    expect(
      outgoingFoldersFor({ home: '/h', roots: ['/r1', '/r2'], missingRoots: ['/r2'] }),
    ).toEqual({ present: ['/h', '/r1'], missing: ['/r2'] });
  });
});

const tmp: string[] = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-outgoing-'));
  tmp.push(d);
  return d;
};
const home = mk();
const sibling = mk();
fs.writeFileSync(path.join(sibling, 'secret.txt'), 'x');
fs.writeFileSync(path.join(home, 'ok.txt'), 'x');
let linked = true;
try {
  // 'junction' so Windows needs no symlink privilege; posix ignores the type.
  fs.symlinkSync(sibling, path.join(home, 'link'), 'junction');
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
  linked = false;
}
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

describe('nodeOutgoingPathDeps (real fs)', () => {
  it.skipIf(!linked)('a link inside home pointing at a sibling dir → symlink-escape', () => {
    const deps = nodeOutgoingPathDeps(process.platform);
    const f = { present: [home], missing: [] };
    expect(validateOutgoingPaths([path.join(home, 'ok.txt')], f, deps)).toEqual({
      ok: true,
      paths: [path.join(home, 'ok.txt')],
    });
    expect(validateOutgoingPaths([path.join(home, 'link', 'secret.txt')], f, deps)).toEqual({
      ok: false,
      reason: 'symlink-escape',
      path: path.join(home, 'link', 'secret.txt'),
    });
  });

  it('a real missing file → missing', () => {
    const deps = nodeOutgoingPathDeps(process.platform);
    const p = path.join(home, 'nope.txt');
    expect(validateOutgoingPaths([p], { present: [home], missing: [] }, deps)).toEqual({
      ok: false,
      reason: 'missing',
      path: p,
    });
  });

  it('caseInsensitive follows the platform', () => {
    expect(nodeOutgoingPathDeps('win32').caseInsensitive).toBe(true);
    expect(nodeOutgoingPathDeps('linux').caseInsensitive).toBe(false);
  });
});
