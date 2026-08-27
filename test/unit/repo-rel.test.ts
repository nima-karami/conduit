import { describe, expect, it } from 'vitest';
import { isUnderRoot, repoRelPath } from '../../src/repo-rel';

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
});
