import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confineToRoots,
  hostRealPathLeaf,
  type LinkFs,
  MAX_LINK_HOPS,
  MAX_WALK_STEPS,
  safeRealPathLeaf,
} from '../../src/path-link-confine';
import { tempRoots } from '../helpers/temp-roots';

/** Identity realpath unless a mapping is given; records every call. */
function spyReal(map: Record<string, string | null> = {}) {
  return vi.fn(async (t: string) => (t in map ? map[t] : t));
}
const WIN = (realPathLeaf: (t: string) => Promise<string | null>, caseSensitive = false) => ({
  realPathLeaf,
  platform: 'win32' as const,
  caseSensitive,
});

describe('confineToRoots (pure)', () => {
  it('outside every root → null, and realPathLeaf is never called', async () => {
    const real = spyReal();
    expect(await confineToRoots('G:/other/x.ts', ['G:/root'], WIN(real))).toBeNull();
    expect(await confineToRoots('G:/rootx/x.ts', ['G:/root'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it.each([
    '//host/x',
    '\\\\host\\x',
    '//?/G:/root/x',
    '\\\\?\\G:\\root\\x',
    '//./pipe/x',
    '\\\\?\\UNC\\h\\s\\x',
  ])('UNC/device input %j → null, and realPathLeaf is never called', async (abs) => {
    const real = spyReal();
    expect(await confineToRoots(abs, ['G:/root', '//host'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it('G:\\ROOT\\x under root G:/root folds case unless caseSensitive', async () => {
    const real = spyReal();
    expect(await confineToRoots('G:\\ROOT\\x', ['G:/root'], WIN(real))).toEqual({
      root: 'G:/root',
      real: 'G:/ROOT/x',
    });
    const strict = spyReal();
    expect(await confineToRoots('G:\\ROOT\\x', ['G:/root'], WIN(strict, true))).toBeNull();
    expect(strict).not.toHaveBeenCalled();
  });

  it('a .. escape → null, and realPathLeaf is never called', async () => {
    const real = spyReal();
    expect(await confineToRoots('G:/root/../other/x', ['G:/root'], WIN(real))).toBeNull();
    expect(await confineToRoots('G:/root/a/../../other/x', ['G:/root'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it('nested roots → the deepest', async () => {
    const real = spyReal();
    const a = await confineToRoots('G:/w/repoA/src/a.ts', ['G:/w', 'G:/w/repoA'], WIN(real));
    expect(a?.root).toBe('G:/w/repoA');
    const b = await confineToRoots('G:/w/repoA/src/a.ts', ['G:/w/repoA', 'G:/w'], WIN(real));
    expect(b?.root).toBe('G:/w/repoA');
  });

  it('a drive root as a root contains its drive', async () => {
    expect(await confineToRoots('G:/x/a.ts', ['G:/'], WIN(spyReal()))).toEqual({
      root: 'G:/',
      real: 'G:/x/a.ts',
    });
  });

  it('realpath leaving the root → null, NOT re-homed to the other root it lands in', async () => {
    const real = spyReal({ 'G:/root/a/link/x': 'G:/other/x' });
    expect(await confineToRoots('G:/root/a/link/x', ['G:/root', 'G:/other'], WIN(real))).toBeNull();
  });

  it('a realpath that is UNC-like → null (a mapped drive resolving to its share)', async () => {
    const real = spyReal({ 'G:/root/x': '\\\\srv\\share\\x' });
    expect(await confineToRoots('G:/root/x', ['G:/root'], WIN(real))).toBeNull();
    // The root resolves to the share too, so containment alone would pass it.
    const mapped = spyReal({ 'Z:/': '//srv/share', 'Z:/x': '//srv/share/x' });
    expect(await confineToRoots('Z:/x', ['Z:/'], WIN(mapped))).toBeNull();
  });

  it('a refused realpath (null) → null', async () => {
    expect(
      await confineToRoots('G:/root/x', ['G:/root'], WIN(spyReal({ 'G:/root/x': null }))),
    ).toBeNull();
    expect(
      await confineToRoots('G:/root/x', ['G:/root'], WIN(spyReal({ 'G:/root': null }))),
    ).toBeNull();
  });

  it("a root that realpaths elsewhere: the file is checked against that root's realpath", async () => {
    const real = spyReal({ 'G:/root': 'H:/real-root', 'G:/root/a.ts': 'H:/real-root/a.ts' });
    expect(await confineToRoots('G:/root/a.ts', ['G:/root'], WIN(real))).toEqual({
      root: 'G:/root',
      real: 'H:/real-root/a.ts',
    });
    const escaped = spyReal({ 'G:/root': 'H:/real-root', 'G:/root/a.ts': 'G:/root/a.ts' });
    expect(await confineToRoots('G:/root/a.ts', ['G:/root'], WIN(escaped))).toBeNull();
  });

  it('a realpath compared case-folded on win32', async () => {
    const real = spyReal({ 'G:/root/a.ts': 'g:/ROOT/a.ts' });
    expect((await confineToRoots('G:/root/a.ts', ['G:/root'], WIN(real)))?.real).toBe(
      'G:/ROOT/a.ts',
    );
  });

  it('a non-absolute input → null without fs', async () => {
    const real = spyReal();
    expect(await confineToRoots('src/a.ts', ['G:/root'], WIN(real))).toBeNull();
    expect(await confineToRoots('', ['G:/root'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it('posix, case-sensitive', async () => {
    const deps = { realPathLeaf: spyReal(), platform: 'posix' as const, caseSensitive: true };
    expect(await confineToRoots('/w/a.ts', ['/w'], deps)).toEqual({ root: '/w', real: '/w/a.ts' });
    expect(await confineToRoots('/W/a.ts', ['/w'], deps)).toBeNull();
  });
});

/** An in-memory fs: `links` are symlinks (target as readlink returns it), `entries` exist; the
 *  realpath of an existing, link-free path is itself. Records every call. */
function fakeFs(entries: string[], links: Record<string, string> = {}) {
  const calls: string[] = [];
  const exists = new Set(entries);
  const fsx: LinkFs = {
    lstat: async (p) => {
      calls.push(`lstat ${p}`);
      if (p in links) return { isSymbolicLink: () => true };
      if (exists.has(p)) return { isSymbolicLink: () => false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readlink: async (p) => {
      calls.push(`readlink ${p}`);
      return links[p];
    },
    realpath: async (p) => {
      calls.push(`realpath ${p}`);
      return p;
    },
  };
  return { fsx, calls };
}

// T8.4 security r1 H2/H3: every link is read before it is followed, so a planted link to a share
// is refused before anything could open an SMB connection to it.
describe('safeRealPathLeaf (injected fs)', () => {
  it.each(['\\\\srv\\share', '//srv/share/x', '\\\\?\\UNC\\srv\\share', '\\\\.\\pipe\\x'])(
    'a component linking to %j → null, and realpath is never called',
    async (to) => {
      const { fsx, calls } = fakeFs(['G:/root'], { 'G:/root/l': to });
      expect(await safeRealPathLeaf('G:/root/l/x.ts', fsx, 'win32')).toBeNull();
      expect(calls.filter((c) => c.startsWith('realpath'))).toEqual([]);
    },
  );

  it('a chain whose second link is UNC-like → null, never realpath', async () => {
    const { fsx, calls } = fakeFs(['G:/root', 'G:/root/b'], {
      'G:/root/a': 'G:\\root\\b\\c',
      'G:/root/b/c': '\\\\srv\\s',
    });
    expect(await safeRealPathLeaf('G:/root/a/x.ts', fsx, 'win32')).toBeNull();
    expect(calls.some((c) => c.startsWith('realpath'))).toBe(false);
  });

  it('a relative link is followed from its own folder', async () => {
    const { fsx } = fakeFs(['G:/root', 'G:/real', 'G:/real/x.ts'], { 'G:/root/l': '..\\real' });
    expect(await safeRealPathLeaf('G:/root/l/x.ts', fsx, 'win32')).toBe('G:/real/x.ts');
  });

  it('a win32 drive-relative link target stays on the drive', async () => {
    const { fsx } = fakeFs(['G:/root', 'G:/real', 'G:/real/x.ts'], { 'G:/root/l': '\\real' });
    expect(await safeRealPathLeaf('G:/root/l/x.ts', fsx, 'win32')).toBe('G:/real/x.ts');
  });

  it('a missing tail: one realpath of the existing part, the tail re-appended', async () => {
    const { fsx, calls } = fakeFs(['G:/root']);
    expect(await safeRealPathLeaf('G:/root/nope/deeper/x.ts', fsx, 'win32')).toBe(
      'G:/root/nope/deeper/x.ts',
    );
    expect(calls).toEqual(['lstat G:/root', 'lstat G:/root/nope', 'realpath G:/root']);
  });

  it('a symlinked parent of a missing leaf still resolves through the link', async () => {
    const { fsx } = fakeFs(['/w', '/out'], { '/w/l': '/out' });
    expect(await safeRealPathLeaf('/w/l/new.ts', fsx, 'posix')).toBe('/out/new.ts');
  });

  // v1 review r2 B1: the virtual tail is collapsed lexically, so a `..` in it would step back
  // out of a missing folder into a real one whose links were never read.
  it('a link through a missing folder and back out with `..` → null (posix)', async () => {
    const { fsx } = fakeFs(['/root', '/root/evil', '/etc'], {
      '/root/a': 'nope/../evil',
      '/root/evil': '/etc',
    });
    const deps = {
      realPathLeaf: (t: string) => safeRealPathLeaf(t, fsx, 'posix'),
      platform: 'posix' as const,
      caseSensitive: true,
    };
    expect(await confineToRoots('/root/a/passwd', ['/root'], deps)).toBeNull();
  });

  it('a link through a missing folder and back out with `..` → null (win32)', async () => {
    const { fsx } = fakeFs(['G:/root', 'G:/root/evil', 'G:/etc'], {
      'G:/root/a': 'nope\\..\\evil',
      'G:/root/evil': 'G:\\etc',
    });
    expect(
      await confineToRoots(
        'G:\\root\\a\\passwd',
        ['G:/root'],
        WIN((t) => safeRealPathLeaf(t, fsx, 'win32')),
      ),
    ).toBeNull();
  });

  it(`a link loop → null after ${MAX_LINK_HOPS} hops`, async () => {
    const { fsx, calls } = fakeFs(['/w'], { '/w/a': '/w/b', '/w/b': '/w/a' });
    expect(await safeRealPathLeaf('/w/a/x', fsx, 'posix')).toBeNull();
    expect(calls.filter((c) => c.startsWith('readlink')).length).toBe(MAX_LINK_HOPS);
  });

  it(`a walk past ${MAX_WALK_STEPS} components → null`, async () => {
    const deep = Array.from({ length: MAX_WALK_STEPS }, (_, i) => `d${i}`);
    const dirs = deep.map((_, i) => `/${deep.slice(0, i + 1).join('/')}`);
    const { fsx } = fakeFs(dirs);
    expect(await safeRealPathLeaf(`/${deep.join('/')}`, fsx, 'posix')).toBe(`/${deep.join('/')}`);
    expect(await safeRealPathLeaf(`/${deep.join('/')}/one-more`, fsx, 'posix')).toBeNull();
  });

  it('an unreadable link → null; a UNC-like realpath → null', async () => {
    const broken = fakeFs(['/w'], { '/w/l': '/x' });
    broken.fsx.readlink = async () => {
      throw new Error('EPERM');
    };
    expect(await safeRealPathLeaf('/w/l/x', broken.fsx, 'posix')).toBeNull();
    const mapped = fakeFs(['Z:/x']);
    mapped.fsx.realpath = async () => '\\\\srv\\share\\x';
    expect(await safeRealPathLeaf('Z:/x', mapped.fsx, 'win32')).toBeNull();
  });

  // v1 review r3: only a missing component is walked past; any other lstat failure fails closed.
  it.each(['EACCES', 'EPERM', 'EIO', undefined])(
    'an lstat failing with %s → null, never realpath',
    async (code) => {
      const { fsx, calls } = fakeFs(['G:/root']);
      const lstat = fsx.lstat;
      fsx.lstat = async (p) => {
        if (p === 'G:/root/locked') throw Object.assign(new Error(String(code)), { code });
        return lstat(p);
      };
      expect(await safeRealPathLeaf('G:/root/locked/x.ts', fsx, 'win32')).toBeNull();
      expect(calls.some((c) => c.startsWith('realpath'))).toBe(false);
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])('an lstat failing with %s is a missing tail', async (code) => {
    const { fsx } = fakeFs(['G:/root']);
    fsx.lstat = async (p) => {
      if (p === 'G:/root') return { isSymbolicLink: () => false };
      throw Object.assign(new Error(code), { code });
    };
    expect(await safeRealPathLeaf('G:/root/a/x.ts', fsx, 'win32')).toBe('G:/root/a/x.ts');
  });

  // v1 review r3: `C:etc` is relative to C:'s per-process cwd, which the walk cannot know.
  it.each(['C:etc', 'c:..\\x', 'C:'])('a drive-relative link target %j → null', async (to) => {
    const { fsx, calls } = fakeFs(['G:/root', 'C:/etc', 'G:/root/C:etc'], { 'G:/root/l': to });
    expect(await safeRealPathLeaf('G:/root/l/x.ts', fsx, 'win32')).toBeNull();
    expect(calls.some((c) => c.startsWith('realpath'))).toBe(false);
  });
});

describe('confineToRoots (fs, hostRealPathLeaf)', () => {
  const { root, cleanup } = tempRoots('confine-');
  afterEach(cleanup);
  const platform = process.platform === 'win32' ? ('win32' as const) : ('posix' as const);
  const deps = {
    realPathLeaf: hostRealPathLeaf(platform),
    platform,
    caseSensitive: process.platform === 'linux',
  };
  const s = (p: string) => p.replace(/\\/g, '/');

  it('a link inside root A pointing into root B → null', async () => {
    const a = root('confine-a-');
    const b = root('confine-b-');
    fs.writeFileSync(path.join(b, 'secret.ts'), 'x');
    // A junction needs no privilege on Windows; elsewhere the type is ignored (a symlink).
    fs.symlinkSync(b, path.join(a, 'link'), 'junction');
    const target = s(path.join(a, 'link', 'secret.ts'));
    expect(await confineToRoots(target, [s(a), s(b)], deps)).toBeNull();
    expect(await confineToRoots(target, [s(a)], deps)).toBeNull();
  });

  it('a link inside the root pointing inside it → its realpath', async () => {
    const a = root('confine-in-');
    fs.mkdirSync(path.join(a, 'real'));
    fs.writeFileSync(path.join(a, 'real', 'x.ts'), 'x');
    fs.symlinkSync(path.join(a, 'real'), path.join(a, 'link'), 'junction');
    const res = await confineToRoots(s(path.join(a, 'link', 'x.ts')), [s(a)], deps);
    expect(res?.real).toBe(s(path.join(a, 'real', 'x.ts')));
  });

  it('a file symlink inside the root pointing outside it → null', async () => {
    const a = root('confine-fa-');
    const out = root('confine-fo-');
    fs.writeFileSync(path.join(out, 'secret.ts'), 'x');
    try {
      fs.symlinkSync(path.join(out, 'secret.ts'), path.join(a, 'link.ts'));
    } catch {
      // File symlinks need a privilege on Windows; the junction case above still runs there.
      return;
    }
    expect(await confineToRoots(s(path.join(a, 'link.ts')), [s(a)], deps)).toBeNull();
  });

  it('a real file under the root → its realpath', async () => {
    const a = root('confine-ok-');
    fs.mkdirSync(path.join(a, 'src'));
    fs.writeFileSync(path.join(a, 'src', 'a.ts'), 'x');
    expect(await confineToRoots(s(path.join(a, 'src', 'a.ts')), [s(a)], deps)).toEqual({
      root: s(a),
      real: s(path.join(a, 'src', 'a.ts')),
    });
  });

  it('a missing leaf under the root → confined (the walk stops at the first missing part)', async () => {
    const a = root('confine-miss-');
    const res = await confineToRoots(s(path.join(a, 'nope', 'x.ts')), [s(a)], deps);
    expect(res?.root).toBe(s(a));
  });
});
