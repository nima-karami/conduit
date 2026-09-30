import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { previewVerdictForPath } from '../../electron/preview-protocol';
import { expandShortNames, type ShortNameDeps } from '../../src/short-names';

interface Entry {
  ino: number;
  link?: boolean;
}

/** A fake volume: every existing path (as spelled, 8.3 aliases included) → its entry, plus the
 *  realpath the OS would report for it (8.3 expanded, links followed). */
function volume(
  p: typeof path.win32 | typeof path.posix,
  entries: Record<string, Entry>,
  real: Record<string, string>,
) {
  const norm = (x: string) => (p === path.win32 ? x.toLowerCase() : x);
  const find = (x: string) => {
    const hit = Object.entries(entries).find(([k]) => norm(k) === norm(x));
    if (!hit) throw Object.assign(new Error(`ENOENT ${x}`), { code: 'ENOENT' });
    return hit[1];
  };
  const lstat = vi.fn(async (x: string) => {
    const e = find(x);
    return { ino: BigInt(e.ino), dev: 1n, isSymbolicLink: () => e.link === true };
  });
  const realpath = vi.fn(async (x: string) => {
    find(x);
    const hit = Object.entries(real).find(([k]) => norm(k) === norm(x));
    return hit ? hit[1] : x;
  });
  const deps: ShortNameDeps = { path: p, lstat, realpath };
  return { deps, lstat, realpath };
}

const W = path.win32;

const RUNNER = {
  'C:\\Users': { ino: 1 },
  'C:\\Users\\RUNNER~1': { ino: 2 },
  'C:\\Users\\runneradmin': { ino: 2 },
  'C:\\Users\\RUNNER~1\\AppData': { ino: 3 },
  'C:\\Users\\runneradmin\\AppData': { ino: 3 },
  'C:\\Users\\RUNNER~1\\AppData\\Local': { ino: 4 },
  'C:\\Users\\runneradmin\\AppData\\Local': { ino: 4 },
  'C:\\Users\\runneradmin\\AppData\\Local\\Temp': { ino: 5 },
  'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp': { ino: 5 },
  'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\conduit sp 1': { ino: 6 },
  'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\conduit sp 1': { ino: 6 },
};
const RUNNER_REAL = {
  'C:\\Users\\RUNNER~1': 'C:\\Users\\runneradmin',
  'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\conduit sp 1':
    'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\conduit sp 1',
};

describe('expandShortNames', () => {
  it('expands an 8.3 component to its long name, keeping every other component as spelled', async () => {
    const { deps } = volume(W, RUNNER, RUNNER_REAL);
    expect(
      await expandShortNames('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\conduit sp 1', deps),
    ).toBe('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\conduit sp 1');
  });

  it('accepts forward slashes (the renderer posts them) when an alias is present', async () => {
    const { deps } = volume(W, RUNNER, RUNNER_REAL);
    expect(await expandShortNames('C:/Users/RUNNER~1/AppData/Local/Temp/conduit sp 1', deps)).toBe(
      'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\conduit sp 1',
    );
  });

  it('returns a path with no 8.3-shaped component untouched, without touching the disk', async () => {
    const { deps, lstat, realpath } = volume(W, RUNNER, RUNNER_REAL);
    for (const p of ['C:/Users/runneradmin/x', 'C:\\a~b\\c', 'C:\\Users\\a~\\b']) {
      expect(await expandShortNames(p, deps)).toBe(p);
    }
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it('never follows a link: a junction with an 8.3-shaped name stays as spelled (mf-model D15)', async () => {
    const { deps, realpath } = volume(
      W,
      { 'C:\\w': { ino: 1 }, 'C:\\w\\LINKTO~1': { ino: 9, link: true } },
      { 'C:\\w\\LINKTO~1': 'D:\\elsewhere\\target' },
    );
    expect(await expandShortNames('C:\\w\\LINKTO~1\\sub', deps)).toBe('C:\\w\\LINKTO~1\\sub');
    expect(realpath).not.toHaveBeenCalled();
  });

  it('keeps the component when the long name is not the same entry (a hard-linked file)', async () => {
    const { deps } = volume(
      W,
      {
        'C:\\w': { ino: 1 },
        'C:\\w\\REPORT~1.TXT': { ino: 7 },
        'C:\\w\\other name.txt': { ino: 8 },
      },
      { 'C:\\w\\REPORT~1.TXT': 'C:\\elsewhere\\other name.txt' },
    );
    expect(await expandShortNames('C:\\w\\REPORT~1.TXT', deps)).toBe('C:\\w\\REPORT~1.TXT');
  });

  it('keeps a missing tail as spelled once a component does not exist', async () => {
    const { deps } = volume(W, RUNNER, RUNNER_REAL);
    expect(await expandShortNames('C:\\Users\\RUNNER~1\\GONE~1\\x', deps)).toBe(
      'C:\\Users\\runneradmin\\GONE~1\\x',
    );
  });

  it('resolves `..` lexically first, so a short alias cannot smuggle a traversal', async () => {
    const { deps } = volume(W, RUNNER, RUNNER_REAL);
    expect(await expandShortNames('C:\\Users\\RUNNER~1\\AppData\\..\\..\\Public', deps)).toBe(
      'C:\\Users\\Public',
    );
  });
});

// POSIX-shaped on purpose: previewVerdictForPath → isInsideRoot resolves through node:path, and the
// gate's CI runner is ubuntu (see preview-verdict.test.ts). The alias logic is platform-agnostic.
describe('a root stored through expandShortNames keeps confinement exactly as strict', () => {
  const P = path.posix;
  const entries = {
    '/home': { ino: 1 },
    '/home/RUNNER~1': { ino: 2 },
    '/home/runneradmin': { ino: 2 },
    '/home/RUNNER~1/proj': { ino: 3 },
    '/home/runneradmin/proj': { ino: 3 },
  };
  const real: Record<string, string> = {
    '/home/RUNNER~1': '/home/runneradmin',
    '/home/RUNNER~1/proj': '/home/runneradmin/proj',
  };
  const file = () => ({ kind: 'file' as const, size: 10 });
  // What the OS reports: the alias expanded, plus one symlink inside the root pointing out.
  const osRealPath = (p: string) =>
    p
      .replace('/home/RUNNER~1/', '/home/runneradmin/')
      .replace('/home/runneradmin/proj/out-link.html', '/etc/secret.html');

  it('the alias-registered root is stored long, and a file under it now passes both checks', async () => {
    const { deps } = volume(P, entries, real);
    const root = await expandShortNames('/home/RUNNER~1/proj', deps);
    expect(root).toBe('/home/runneradmin/proj');
    expect(previewVerdictForPath(`${root}/a.html`, [root], file, osRealPath).ok).toBe(true);
    // Before the fix: the root kept the alias and the realpath stage refused its own file.
    const before = previewVerdictForPath(
      '/home/RUNNER~1/proj/a.html',
      ['/home/RUNNER~1/proj'],
      file,
      osRealPath,
    );
    expect(before).toMatchObject({ ok: false, detail: 'Resolves outside the workspace.' });
  });

  it('still refuses `../..` out of the canonical root (lexical stage)', async () => {
    const { deps } = volume(P, entries, real);
    const root = await expandShortNames('/home/RUNNER~1/proj', deps);
    const v = previewVerdictForPath(`${root}/../../../etc/passwd`, [root], file, osRealPath);
    expect(v).toMatchObject({
      ok: false,
      reason: 'blocked',
      detail: 'Outside the open workspace.',
    });
  });

  it('still refuses a symlink inside the canonical root that points out (realpath stage)', async () => {
    const { deps } = volume(P, entries, real);
    const root = await expandShortNames('/home/RUNNER~1/proj', deps);
    const v = previewVerdictForPath(`${root}/out-link.html`, [root], file, osRealPath);
    expect(v).toMatchObject({
      ok: false,
      reason: 'blocked',
      detail: 'Resolves outside the workspace.',
    });
  });

  it('still refuses a sibling that only shares the long prefix', async () => {
    const { deps } = volume(P, entries, real);
    const root = await expandShortNames('/home/RUNNER~1/proj', deps);
    const v = previewVerdictForPath('/home/runneradmin/proj-evil/a.html', [root], file, osRealPath);
    expect(v.ok).toBe(false);
  });
});
