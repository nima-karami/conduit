import { describe, expect, it } from 'vitest';
import { extractDirArg } from '../../electron/arg-utils';

// Injected directory predicate: treat exactly these paths as existing directories.
const dirsAre = (dirs: string[]) => (p: string) => dirs.includes(p);

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
