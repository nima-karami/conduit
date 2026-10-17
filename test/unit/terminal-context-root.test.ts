import { describe, expect, it } from 'vitest';
import type { ResolveRoot } from '../../src/path-link-roots';
import { CONTEXT_WINDOW_LINES, inferContextRoot } from '../../webview/terminal-context-root';

const root = (abs: string, kind: ResolveRoot['kind'] = 'nested'): ResolveRoot => ({
  abs,
  kind,
  name: abs.split('/').pop() ?? abs,
  userChosen: true,
});
const POSIX = { cwd: '/w', platform: 'posix' as const, caseSensitive: true };
const ROOTS = [root('/w', 'home'), root('/w/repoA'), root('/w/repoB'), root('/w/my repo')];

describe('inferContextRoot', () => {
  it('Bash(cd <abs> && …) on win32 → that repo', () => {
    const roots = [root('G:/work', 'home'), root('G:/work/repoA'), root('G:/work/repoB')];
    const idx = inferContextRoot(['  ⎿  ok', 'Bash(cd G:/work/repoA && npm test)'], roots, {
      cwd: 'G:/work',
      platform: 'win32',
      caseSensitive: false,
    });
    expect(idx).toBe(1);
  });

  it('a win32 backslash cd with different case folds onto the root', () => {
    const roots = [root('G:/work', 'home'), root('G:/work/repoA'), root('G:/work/repoB')];
    const idx = inferContextRoot(['PS> cd g:\\WORK\\repoB'], roots, {
      cwd: 'G:/work',
      platform: 'win32',
      caseSensitive: false,
    });
    expect(idx).toBe(2);
  });

  it('a relative cd resolves against the cwd', () => {
    expect(inferContextRoot(['$ cd repoB'], ROOTS, POSIX)).toBe(2);
  });

  it('a relative cd resolves against the previous (farther up) cd', () => {
    // Chronologically: cd /w/repoA/sub, then cd ../../repoB.
    expect(inferContextRoot(['$ cd ../../repoB', '$ cd /w/repoA/sub'], ROOTS, POSIX)).toBe(2);
  });

  it('git -C <dir> → that repo', () => {
    expect(inferContextRoot(['$ git -C /w/repoB status'], ROOTS, POSIX)).toBe(2);
  });

  it('the nearest signal wins over a farther one', () => {
    expect(inferContextRoot(['$ cd /w/repoA', 'x', '$ cd /w/repoB'], ROOTS, POSIX)).toBe(1);
  });

  it('an absolute path printed under a repo → that repo', () => {
    expect(inferContextRoot(['  Read /w/repoA/src/util.ts (12 lines)'], ROOTS, POSIX)).toBe(1);
  });

  it('a cd on the same line outranks a printed path', () => {
    expect(inferContextRoot(['/w/repoA/x.ts && cd /w/repoB'], ROOTS, POSIX)).toBe(2);
  });

  it('a signal outside every root is skipped and the search continues farther up', () => {
    expect(inferContextRoot(['$ cd /elsewhere/x', '$ cd /w/repoB'], ROOTS, POSIX)).toBe(2);
  });

  it('a path under home only → the home root (deepest wins, home is still a root)', () => {
    expect(inferContextRoot(['$ cd /w/docs'], ROOTS, POSIX)).toBe(0);
  });

  it('no signal → undefined', () => {
    expect(inferContextRoot(['hello', 'src/index.ts', '$ npm test'], ROOTS, POSIX)).toBeUndefined();
    expect(inferContextRoot([], ROOTS, POSIX)).toBeUndefined();
  });

  it('lines beyond CONTEXT_WINDOW_LINES are ignored', () => {
    const lines = [...Array.from({ length: CONTEXT_WINDOW_LINES }, () => 'noise'), '$ cd /w/repoA'];
    expect(inferContextRoot(lines, ROOTS, POSIX)).toBeUndefined();
    expect(inferContextRoot(lines.slice(1), ROOTS, POSIX)).toBe(1);
  });

  it('a quoted cd keeps its spaces', () => {
    expect(inferContextRoot(['$ cd "/w/my repo"'], ROOTS, POSIX)).toBe(3);
    expect(inferContextRoot(["$ cd '/w/my repo/src'"], ROOTS, POSIX)).toBe(3);
  });

  it('case-sensitive platforms do not fold', () => {
    expect(inferContextRoot(['$ cd /w/REPOA'], ROOTS, POSIX)).toBe(0);
  });

  it('`cd -`, `cd ~` and a bare `cd` are no signal', () => {
    expect(inferContextRoot(['$ cd -', '$ cd ~/x', '$ cd'], ROOTS, POSIX)).toBeUndefined();
  });

  it('a word ending in cd is not a cd', () => {
    expect(inferContextRoot(['$ abcd /w/repoB_x'], [root('/w/repoB_x')], POSIX)).toBe(0);
    expect(inferContextRoot(['$ abcd repoB'], ROOTS, POSIX)).toBeUndefined();
  });
});
