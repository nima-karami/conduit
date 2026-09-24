import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DetectedRepo, detectRepos, scanSessionRepos } from '../../src/repo-scan';
import type { Session } from '../../src/types';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'reposcan-'));
}
// `detectRepos` only checks for a `.git` entry, so a bare `.git` dir is enough — no need to
// shell out to real `git init` (that flakes under parallel-vitest contention).
function gitInit(dir: string) {
  mkdirSync(join(dir, '.git'), { recursive: true });
}

describe('detectRepos', () => {
  it('finds direct-child repos and names them relative to the opened root', async () => {
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    gitInit(join(root, 'repo-b'));
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name).sort()).toEqual(['repo-a', 'repo-b']);
    expect(repos.every((r) => r.root.replace(/\\/g, '/').endsWith(r.name))).toBe(true);
  });

  it('includes the opened root itself when it is a repo, named "."', async () => {
    const root = tmp();
    gitInit(root);
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name)).toContain('.');
  });

  it('finds nested repos within the depth bound but not beyond it', async () => {
    const root = tmp();
    gitInit(join(root, 'group', 'repo-c')); // depth 2 — within 4
    gitInit(join(root, 'a', 'b', 'c', 'd', 'e', 'deep')); // depth 6 — beyond 4
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('group/repo-c');
    expect(names.some((n) => n.endsWith('deep'))).toBe(false);
  });

  it('does not descend into a repo once found (no repos-inside-repos)', async () => {
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    gitInit(join(root, 'repo-a', 'nested')); // should NOT be reported separately
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('repo-a');
    expect(names).not.toContain('repo-a/nested');
  });

  it('skips node_modules and treats a .git FILE (submodule/worktree) as a repo', async () => {
    const root = tmp();
    mkdirSync(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
    const sub = join(root, 'submod');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: /elsewhere/.git/modules/submod');
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('submod');
    expect(names.some((n) => n.startsWith('node_modules'))).toBe(false);
  });

  it('returns [] for a non-existent root and never throws on a symlink cycle', async () => {
    expect(await detectRepos(join(tmpdir(), 'does-not-exist-xyz-reposcan'))).toEqual([]);
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    try {
      symlinkSync(root, join(root, 'loop'), 'dir'); // self-referential dir symlink
    } catch {
      return; // symlink may be unavailable (Windows w/o privilege) — cycle case skipped
    }
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name)).toContain('repo-a'); // terminated, no hang
  });
});

describe('scanSessionRepos', () => {
  type Repos = Record<string, DetectedRepo[]>;
  function deps(down: Repos, up: Record<string, string | Error> = {}) {
    const calls = { detect: [] as string[], enclosing: [] as string[] };
    return {
      calls,
      deps: {
        detect: async (f: string) => {
          calls.detect.push(f);
          return down[f] ?? [];
        },
        enclosing: async (f: string) => {
          calls.enclosing.push(f);
          const v = up[f] ?? '';
          if (v instanceof Error) throw v;
          return v;
        },
      },
    };
  }
  const session = (home: string, roots: string[] = [], extra: Partial<Session> = {}) => ({
    home,
    roots,
    ...extra,
  });

  it('home tagged home, sub-repo nested, attached-root repo attached', async () => {
    const { deps: d } = deps({
      'C:/w/home': [
        { root: 'C:/w/home', name: '.' },
        { root: 'C:/w/home/sub', name: 'sub' },
      ],
      'C:/w/att': [{ root: 'C:/w/att', name: '.' }],
    });
    expect(await scanSessionRepos(session('C:/w/home', ['C:/w/att']), d)).toEqual([
      { root: 'C:/w/home', name: '.', folder: 'C:/w/home', tag: 'home' },
      { root: 'C:/w/home/sub', name: 'sub', folder: 'C:/w/home', tag: 'nested' },
      { root: 'C:/w/att', name: '.', folder: 'C:/w/att', tag: 'attached' },
    ]);
  });

  it('dedupe by key, first wins', async () => {
    const { deps: d } = deps({
      'C:/w/home': [
        { root: 'C:/w/home', name: '.' },
        { root: 'C:/w/home/sub', name: 'sub' },
      ],
      'C:/w/home/sub': [{ root: 'c:\\W\\home\\sub', name: '.' }],
    });
    const out = await scanSessionRepos(session('C:/w/home', ['C:/w/home/sub']), d);
    expect(out.map((r) => [r.root, r.tag])).toEqual([
      ['C:/w/home', 'home'],
      ['C:/w/home/sub', 'nested'],
    ]);
  });

  it('home first, then roots order', async () => {
    const { deps: d, calls } = deps({
      'C:/w/b': [{ root: 'C:/w/b', name: '.' }],
      'C:/w/a': [{ root: 'C:/w/a', name: '.' }],
      'C:/w/home': [{ root: 'C:/w/home', name: '.' }],
    });
    const out = await scanSessionRepos(session('C:/w/home', ['C:/w/b', 'C:/w/a']), d);
    expect(out.map((r) => r.root)).toEqual(['C:/w/home', 'C:/w/b', 'C:/w/a']);
    expect(calls.detect).toEqual(['C:/w/home', 'C:/w/b', 'C:/w/a']);
  });

  it('cap 200', async () => {
    const many = (base: string) =>
      Array.from({ length: 150 }, (_, i) => ({ root: `${base}/r${i}`, name: `r${i}` }));
    const { deps: d } = deps({ '/h': many('/h'), '/a': many('/a') });
    const out = await scanSessionRepos(session('/h', ['/a']), d);
    expect(out).toHaveLength(200);
    expect(out[199]).toMatchObject({ root: '/a/r49', tag: 'attached' });
  });

  it('missing home and missing roots not scanned (neither detect nor enclosing called)', async () => {
    const { deps: d, calls } = deps({ '/b': [{ root: '/b', name: '.' }] });
    const out = await scanSessionRepos(
      session('/h', ['/a', '/b'], { homeMissing: true, missingRoots: ['/a'] }),
      d,
    );
    expect(out.map((r) => r.root)).toEqual(['/b']);
    expect(calls.detect).toEqual(['/b']);
    expect(calls.enclosing).toEqual([]);
  });

  it('home = repo/packages/foo → enclosing repo listed, tag home, folder = home', async () => {
    const { deps: d } = deps({}, { 'G:/repo/packages/foo': 'G:/repo' });
    expect(await scanSessionRepos(session('G:/repo/packages/foo'), d)).toEqual([
      { root: 'G:/repo', name: 'repo', folder: 'G:/repo/packages/foo', tag: 'home' },
    ]);
  });

  it('enclosing repo is placed before that folder’s downward results', async () => {
    const { deps: d } = deps(
      { '/g/pk': [{ root: '/g/pk/inner', name: 'inner' }] },
      { '/g/pk': '/g' },
    );
    const out = await scanSessionRepos(session('/g/pk'), d);
    expect(out.map((r) => [r.root, r.tag])).toEqual([
      ['/g', 'home'],
      ['/g/pk/inner', 'nested'],
    ]);
  });

  it('attached folder inside a repo → enclosing repo tagged attached', async () => {
    const { deps: d } = deps(
      { '/h': [{ root: '/h', name: '.' }] },
      { 'C:/x/repo/sub': 'C:\\x\\repo' },
    );
    const out = await scanSessionRepos(session('/h', ['C:/x/repo/sub']), d);
    expect(out[1]).toEqual({
      root: 'C:/x/repo',
      name: 'repo',
      folder: 'C:/x/repo/sub',
      tag: 'attached',
    });
  });

  it('two attached folders in one repo → one entry', async () => {
    const { deps: d } = deps({}, { '/r/a': '/r', '/r/b': '/r' });
    const out = await scanSessionRepos(session('/h', ['/r/a', '/r/b']), d);
    expect(out).toEqual([{ root: '/r', name: 'r', folder: '/r/a', tag: 'attached' }]);
  });

  it('folder that is itself a repo root → enclosing not called', async () => {
    const { deps: d, calls } = deps(
      { 'C:/w/home': [{ root: 'c:/W/home', name: '.' }] },
      { 'C:/w/home': 'C:/w' },
    );
    await scanSessionRepos(session('C:/w/home'), d);
    expect(calls.enclosing).toEqual([]);
  });

  it('enclosing that answers the folder itself adds no entry', async () => {
    const { deps: d } = deps({}, { 'C:/w/h': 'c:/W/h' });
    expect(await scanSessionRepos(session('C:/w/h'), d)).toEqual([]);
  });

  it('enclosing rejects → no entry, no throw', async () => {
    const { deps: d } = deps(
      { '/a': [{ root: '/a/x', name: 'x' }] },
      { '/h': new Error('git gone'), '/a': new Error('git gone') },
    );
    const out = await scanSessionRepos(session('/h', ['/a']), d);
    expect(out).toEqual([{ root: '/a/x', name: 'x', folder: '/a', tag: 'attached' }]);
  });
});
