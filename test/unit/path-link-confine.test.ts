import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confineToRoots, slashedRealPathLeaf } from '../../src/path-link-confine';
import { tempRoots } from '../helpers/temp-roots';

/** Identity realpath unless a mapping is given; records every call. */
function spyReal(map: Record<string, string> = {}) {
  return vi.fn((t: string) => map[t] ?? t);
}
const WIN = (realPathLeaf: (t: string) => string, caseSensitive = false) => ({
  realPathLeaf,
  platform: 'win32' as const,
  caseSensitive,
});

describe('confineToRoots (pure)', () => {
  it('outside every root → null, and realPathLeaf is never called', () => {
    const real = spyReal();
    expect(confineToRoots('G:/other/x.ts', ['G:/root'], WIN(real))).toBeNull();
    expect(confineToRoots('G:/rootx/x.ts', ['G:/root'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it.each([
    '//host/x',
    '\\\\host\\x',
    '//?/G:/root/x',
    '\\\\?\\G:\\root\\x',
    '//./pipe/x',
    '\\\\?\\UNC\\h\\s\\x',
  ])('UNC/device input %j → null, and realPathLeaf is never called', (abs) => {
    const real = spyReal();
    expect(confineToRoots(abs, ['G:/root', '//host'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it('G:\\ROOT\\x under root G:/root folds case unless caseSensitive', () => {
    const real = spyReal();
    expect(confineToRoots('G:\\ROOT\\x', ['G:/root'], WIN(real))).toEqual({
      root: 'G:/root',
      real: 'G:/ROOT/x',
    });
    const strict = spyReal();
    expect(confineToRoots('G:\\ROOT\\x', ['G:/root'], WIN(strict, true))).toBeNull();
    expect(strict).not.toHaveBeenCalled();
  });

  it('a .. escape → null, and realPathLeaf is never called', () => {
    const real = spyReal();
    expect(confineToRoots('G:/root/../other/x', ['G:/root'], WIN(real))).toBeNull();
    expect(confineToRoots('G:/root/a/../../other/x', ['G:/root'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it('nested roots → the deepest', () => {
    const real = spyReal();
    expect(confineToRoots('G:/w/repoA/src/a.ts', ['G:/w', 'G:/w/repoA'], WIN(real))?.root).toBe(
      'G:/w/repoA',
    );
    expect(confineToRoots('G:/w/repoA/src/a.ts', ['G:/w/repoA', 'G:/w'], WIN(real))?.root).toBe(
      'G:/w/repoA',
    );
  });

  it('a drive root as a root contains its drive', () => {
    expect(confineToRoots('G:/x/a.ts', ['G:/'], WIN(spyReal()))).toEqual({
      root: 'G:/',
      real: 'G:/x/a.ts',
    });
  });

  it('realpath leaving the root → null, NOT re-homed to the other root it lands in', () => {
    const real = spyReal({ 'G:/root/a/link/x': 'G:/other/x' });
    expect(confineToRoots('G:/root/a/link/x', ['G:/root', 'G:/other'], WIN(real))).toBeNull();
  });

  it('a realpath that is UNC-like → null (a mapped drive resolving to its share)', () => {
    const real = spyReal({ 'G:/root/x': '\\\\srv\\share\\x' });
    expect(confineToRoots('G:/root/x', ['G:/root'], WIN(real))).toBeNull();
    // The root resolves to the share too, so containment alone would pass it.
    const mapped = spyReal({ 'Z:/': '//srv/share', 'Z:/x': '//srv/share/x' });
    expect(confineToRoots('Z:/x', ['Z:/'], WIN(mapped))).toBeNull();
  });

  it("a root that realpaths elsewhere: the file is checked against that root's realpath", () => {
    const real = spyReal({ 'G:/root': 'H:/real-root', 'G:/root/a.ts': 'H:/real-root/a.ts' });
    expect(confineToRoots('G:/root/a.ts', ['G:/root'], WIN(real))).toEqual({
      root: 'G:/root',
      real: 'H:/real-root/a.ts',
    });
    const escaped = spyReal({ 'G:/root': 'H:/real-root', 'G:/root/a.ts': 'G:/root/a.ts' });
    expect(confineToRoots('G:/root/a.ts', ['G:/root'], WIN(escaped))).toBeNull();
  });

  it('a realpath compared case-folded on win32', () => {
    const real = spyReal({ 'G:/root/a.ts': 'g:/ROOT/a.ts' });
    expect(confineToRoots('G:/root/a.ts', ['G:/root'], WIN(real))?.real).toBe('G:/ROOT/a.ts');
  });

  it('a non-absolute input → null without fs', () => {
    const real = spyReal();
    expect(confineToRoots('src/a.ts', ['G:/root'], WIN(real))).toBeNull();
    expect(confineToRoots('', ['G:/root'], WIN(real))).toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it('posix, case-sensitive', () => {
    const deps = { realPathLeaf: spyReal(), platform: 'posix' as const, caseSensitive: true };
    expect(confineToRoots('/w/a.ts', ['/w'], deps)).toEqual({ root: '/w', real: '/w/a.ts' });
    expect(confineToRoots('/W/a.ts', ['/w'], deps)).toBeNull();
  });
});

describe('confineToRoots (fs, default realPathLeaf)', () => {
  const { root, cleanup } = tempRoots('confine-');
  afterEach(cleanup);
  const deps = {
    realPathLeaf: slashedRealPathLeaf,
    platform: process.platform === 'win32' ? ('win32' as const) : ('posix' as const),
    caseSensitive: process.platform === 'linux',
  };
  const s = (p: string) => p.replace(/\\/g, '/');

  it('a link inside root A pointing into root B → null', () => {
    const a = root('confine-a-');
    const b = root('confine-b-');
    fs.writeFileSync(path.join(b, 'secret.ts'), 'x');
    // A junction needs no privilege on Windows; elsewhere the type is ignored (a symlink).
    fs.symlinkSync(b, path.join(a, 'link'), 'junction');
    const target = s(path.join(a, 'link', 'secret.ts'));
    expect(confineToRoots(target, [s(a), s(b)], deps)).toBeNull();
    expect(confineToRoots(target, [s(a)], deps)).toBeNull();
  });

  it('a file symlink inside the root pointing outside it → null', () => {
    const a = root('confine-fa-');
    const out = root('confine-fo-');
    fs.writeFileSync(path.join(out, 'secret.ts'), 'x');
    try {
      fs.symlinkSync(path.join(out, 'secret.ts'), path.join(a, 'link.ts'));
    } catch {
      // File symlinks need a privilege on Windows; the junction case above still runs there.
      return;
    }
    expect(confineToRoots(s(path.join(a, 'link.ts')), [s(a)], deps)).toBeNull();
  });

  it('a real file under the root → its realpath', () => {
    const a = root('confine-ok-');
    fs.mkdirSync(path.join(a, 'src'));
    fs.writeFileSync(path.join(a, 'src', 'a.ts'), 'x');
    expect(confineToRoots(s(path.join(a, 'src', 'a.ts')), [s(a)], deps)).toEqual({
      root: s(a),
      real: s(path.join(a, 'src', 'a.ts')),
    });
  });

  it('a missing leaf under the root → confined (realPathLeaf walks up)', () => {
    const a = root('confine-miss-');
    const res = confineToRoots(s(path.join(a, 'nope', 'x.ts')), [s(a)], deps);
    expect(res?.root).toBe(s(a));
  });
});
