import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandToken,
  isAbsoluteToken,
  isUncLike,
  joinAbs,
  normalizeAbs,
} from '../../src/path-token-normalize';

describe('normalizeAbs', () => {
  it.each([
    ['G:\\work\\repoA\\..\\repoB\\x.ts', 'win32', 'G:/work/repoB/x.ts'], // row 13
    ['g:/a/./b/', 'win32', 'G:/a/b'],
    ['/a//b/../c', 'posix', '/a/c'],
    ['/../a', 'posix', '/a'],
    ['G:/../a', 'win32', 'G:/a'],
    ['G:/', 'win32', 'G:/'],
    ['g:\\', 'win32', 'G:/'],
    ['/', 'posix', '/'],
    ['/a/b/', 'posix', '/a/b'],
    ['//server/share/a/../b', 'win32', '//server/share/b'],
    ['\\\\server\\share\\..\\..\\x', 'win32', '//server/share/x'],
    ['g:/a', 'posix', 'g:/a'],
  ] as const)('%s (%s) → %s', (input, platform, out) => {
    expect(normalizeAbs(input, platform)).toBe(out);
  });
});

describe('expandToken', () => {
  const win = { platform: 'win32' as const, homeDir: 'C:/Users/u' };
  const posix = { platform: 'posix' as const, homeDir: '/home/u' };

  it('expands ~ and ~/x (row 23)', () => {
    expect(expandToken('~', posix)).toBe('/home/u');
    expect(expandToken('~/foo/bar.ts', posix)).toBe('/home/u/foo/bar.ts');
    expect(expandToken('~\\foo\\bar.ts', win)).toBe('C:/Users/u/foo/bar.ts');
    expect(expandToken('~user/x', posix)).toBe('~user/x');
  });

  it('maps MSYS /x/ on win32 only (row 16)', () => {
    expect(expandToken('/g/work/x.ts', win)).toBe('G:/work/x.ts');
    expect(expandToken('/g', win)).toBe('G:/');
    expect(expandToken('/g/work/x.ts', posix)).toBe('/g/work/x.ts');
    expect(expandToken('/c/foo', posix)).toBe('/c/foo');
  });

  it('maps WSL /mnt/x/ on win32 only (row 17)', () => {
    expect(expandToken('/mnt/g/work/x.ts', win)).toBe('G:/work/x.ts');
    expect(expandToken('/mnt/g/work/x.ts', posix)).toBe('/mnt/g/work/x.ts');
  });

  it('leaves a two-letter first segment alone', () => {
    expect(expandToken('/gx/work', win)).toBe('/gx/work');
  });

  it('folds backslashes and leaves other tokens unchanged', () => {
    expect(expandToken('src\\index.ts', win)).toBe('src/index.ts');
    expect(expandToken('G:/work/../x', win)).toBe('G:/work/../x');
  });
});

describe('isAbsoluteToken / joinAbs', () => {
  it('classifies', () => {
    expect(isAbsoluteToken('src/x', 'posix')).toBe(false);
    expect(isAbsoluteToken('/x', 'posix')).toBe(true);
    expect(isAbsoluteToken('G:/x', 'win32')).toBe(true);
    expect(isAbsoluteToken('G:\\x', 'win32')).toBe(true);
    expect(isAbsoluteToken('//server/share', 'win32')).toBe(true);
    expect(isAbsoluteToken('./x', 'win32')).toBe(false);
  });

  it('joins segment-aware then normalises (row 14)', () => {
    expect(joinAbs('G:/work/repoA/src', '../webview/app.tsx', 'win32')).toBe(
      'G:/work/repoA/webview/app.tsx',
    );
    expect(joinAbs('/w/', './src/a.ts', 'posix')).toBe('/w/src/a.ts');
    expect(joinAbs('/w', 'src/', 'posix')).toBe('/w/src');
    expect(joinAbs('/w', '/abs/x', 'posix')).toBe('/abs/x');
    expect(joinAbs('/w/a', '../../../x', 'posix')).toBe('/x');
  });
});

describe('isUncLike', () => {
  it.each([
    '//host/x',
    '\\\\host\\x',
    '\\\\?\\UNC\\h\\s',
    '\\\\.\\pipe\\x',
    '\\\\?\\G:\\root\\x',
    '//?/G:/x',
  ])('%s is UNC-like', (p) => {
    expect(isUncLike(p)).toBe(true);
  });

  it.each(['/x', 'G:/x', 'G:\\ROOT\\x', 'src/x'])('%s is not', (p) => {
    expect(isUncLike(p)).toBe(false);
  });
});

it('is browser-safe: imports no node: module', () => {
  const src = readFileSync(join(__dirname, '../../src/path-token-normalize.ts'), 'utf8');
  expect(src).not.toMatch(/from\s+['"]node:/);
  expect(src).not.toMatch(/process\.platform/);
});
