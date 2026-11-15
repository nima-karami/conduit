import { describe, expect, it } from 'vitest';
import { foldRelPath, isUnderRoot, repoRelPath } from '../../src/repo-rel';

describe('foldRelPath', () => {
  it('lowercases on a windows drive root', () => {
    expect(foldRelPath('C:\\', 'Src/A.ts')).toBe('src/a.ts');
  });

  it('leaves a posix root case alone', () => {
    expect(foldRelPath('/', 'Src/A.ts')).toBe('Src/A.ts');
  });
});

describe('repoRelPath', () => {
  it('returns a posix relative path for a posix root', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/repo/src/a.ts')).toBe('src/a.ts');
  });

  it('normalises backslashes on a windows root', () => {
    expect(repoRelPath('C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  it('ignores drive-letter case on a windows root', () => {
    expect(repoRelPath('c:/work/repo', 'C:/Work/Repo/src/a.ts')).toBe('src/a.ts');
  });

  it('is case-sensitive on a posix root', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/Repo/src/a.ts')).toBeNull();
  });

  it('tolerates a trailing separator on the root', () => {
    expect(repoRelPath('/home/u/repo/', '/home/u/repo/a.ts')).toBe('a.ts');
  });

  it('rejects a sibling directory sharing the root prefix', () => {
    expect(repoRelPath('/work', '/work-evil/a.ts')).toBeNull();
  });

  it('treats a file on a windows drive root as under the root', () => {
    expect(repoRelPath('C:\\', 'C:\\Users\\x\\a.ts')).toBe('Users/x/a.ts');
  });

  it('ignores drive-letter case on a windows drive root', () => {
    expect(repoRelPath('C:\\', 'c:\\Users\\x\\a.ts')).toBe('Users/x/a.ts');
  });

  it('treats a file under a posix filesystem root as under the root', () => {
    expect(repoRelPath('/', '/etc/hosts')).toBe('etc/hosts');
  });

  it('rejects the root itself', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/repo')).toBeNull();
  });

  it('rejects a path that climbs out with ..', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/repo/../secret.ts')).toBeNull();
  });
});

describe('isUnderRoot', () => {
  it('is true for a contained file and false for a sibling', () => {
    expect(isUnderRoot('/home/u/repo', '/home/u/repo/src/a.ts')).toBe(true);
    expect(isUnderRoot('/home/u/repo', '/home/u/other/a.ts')).toBe(false);
  });

  it('matches a windows root regardless of separator style', () => {
    expect(isUnderRoot('C:\\work\\repo', 'C:/work/repo/src/a.ts')).toBe(true);
  });

  it('is true for a file on a drive root and on a posix root', () => {
    expect(isUnderRoot('C:\\', 'C:\\Users\\x\\a.ts')).toBe(true);
    expect(isUnderRoot('/', '/etc/hosts')).toBe(true);
  });
});
