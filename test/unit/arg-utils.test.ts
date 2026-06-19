import { describe, expect, it } from 'vitest';
import { extractDirArg, extractOpenTarget, gitRootOf } from '../../electron/arg-utils';

// Injected directory predicate: treat exactly these paths as existing directories.
const dirsAre = (dirs: string[]) => (p: string) => dirs.includes(p);

// Injected classifier: map exact paths to a kind; everything else is 'none'.
const classifyAs =
  (kinds: Record<string, 'dir' | 'file'>) =>
  (p: string): 'dir' | 'file' | 'none' =>
    kinds[p] ?? 'none';

describe('extractDirArg', () => {
  it('returns the directory argument after the packaged exe path', () => {
    expect(extractDirArg(['C:/App/Conduit.exe', 'C:/work/proj'], dirsAre(['C:/work/proj']))).toBe(
      'C:/work/proj',
    );
  });

  it('skips the Electron dev "." argument', () => {
    expect(extractDirArg(['electron', '.', 'C:/work/proj'], dirsAre(['C:/work/proj']))).toBe(
      'C:/work/proj',
    );
  });

  it('skips --flags', () => {
    expect(
      extractDirArg(
        ['Conduit.exe', '--squirrel-firstrun', 'C:/work/proj'],
        dirsAre(['C:/work/proj']),
      ),
    ).toBe('C:/work/proj');
  });

  it('returns undefined when no argument is a directory (e.g. a file path)', () => {
    expect(extractDirArg(['Conduit.exe', 'C:/work/file.txt'], dirsAre([]))).toBeUndefined();
  });

  it('returns undefined for argv with only the exe path', () => {
    expect(extractDirArg(['Conduit.exe'], dirsAre([]))).toBeUndefined();
  });

  it('returns the first directory when several match', () => {
    expect(extractDirArg(['Conduit.exe', 'C:/a', 'C:/b'], dirsAre(['C:/a', 'C:/b']))).toBe('C:/a');
  });
});

describe('extractOpenTarget', () => {
  it('returns a dir target for a folder argument', () => {
    expect(
      extractOpenTarget(
        ['C:/App/Conduit.exe', 'C:/work/proj'],
        classifyAs({ 'C:/work/proj': 'dir' }),
      ),
    ).toEqual({ kind: 'dir', path: 'C:/work/proj' });
  });

  it('returns a file target for a file argument', () => {
    expect(
      extractOpenTarget(
        ['C:/App/Conduit.exe', 'C:/work/proj/a.ts'],
        classifyAs({ 'C:/work/proj/a.ts': 'file' }),
      ),
    ).toEqual({ kind: 'file', path: 'C:/work/proj/a.ts' });
  });

  it('skips the exe path (classified none), the dev "." arg, and --flags', () => {
    expect(
      extractOpenTarget(
        ['electron', '.', '--squirrel-firstrun', 'C:/work/proj/a.ts'],
        classifyAs({ 'C:/work/proj/a.ts': 'file' }),
      ),
    ).toEqual({ kind: 'file', path: 'C:/work/proj/a.ts' });
  });

  it('returns undefined when nothing classifies as dir or file', () => {
    expect(extractOpenTarget(['Conduit.exe', 'C:/missing'], classifyAs({}))).toBeUndefined();
  });

  it('returns undefined for argv with only the exe path', () => {
    expect(extractOpenTarget(['Conduit.exe'], classifyAs({}))).toBeUndefined();
  });

  it('returns the first matching target when several exist (first match wins)', () => {
    expect(
      extractOpenTarget(
        ['Conduit.exe', 'C:/work/proj/a.ts', 'C:/work/other'],
        classifyAs({ 'C:/work/proj/a.ts': 'file', 'C:/work/other': 'dir' }),
      ),
    ).toEqual({ kind: 'file', path: 'C:/work/proj/a.ts' });
  });
});

describe('gitRootOf', () => {
  // Injected existence predicate: treat exactly these paths as existing entries.
  const exist = (paths: string[]) => (p: string) => paths.includes(p);

  it('returns the nearest ancestor directory containing a .git', () => {
    expect(gitRootOf('C:/work/proj/src/deep/a.ts', exist(['C:/work/proj/.git']))).toBe(
      'C:/work/proj',
    );
  });

  it("finds a .git in the file's immediate parent", () => {
    expect(gitRootOf('C:/work/proj/a.ts', exist(['C:/work/proj/.git']))).toBe('C:/work/proj');
  });

  it('returns the deepest repo when nested .git dirs exist', () => {
    expect(
      gitRootOf('C:/work/proj/sub/a.ts', exist(['C:/work/proj/.git', 'C:/work/proj/sub/.git'])),
    ).toBe('C:/work/proj/sub');
  });

  it('returns undefined when no ancestor has a .git', () => {
    expect(gitRootOf('C:/work/proj/a.ts', exist([]))).toBeUndefined();
  });

  it('handles backslash (Windows) separators', () => {
    expect(gitRootOf('C:\\work\\proj\\src\\a.ts', exist(['C:\\work\\proj\\.git']))).toBe(
      'C:\\work\\proj',
    );
  });
});
