import { describe, expect, it } from 'vitest';
import { pathBelow, renamedPath } from '../../src/canonical-path';

describe('pathBelow', () => {
  it('matches a tree spelling against a tab spelling of the same file', () => {
    expect(pathBelow('C:\\p\\a.ts', 'C:/p/a.ts')).toBe('');
    expect(pathBelow('c:/p/a.ts', 'C:\\p\\a.ts')).toBe('');
  });

  it('returns the remainder under a folder, with its separator', () => {
    expect(pathBelow('C:\\p\\dir\\c.ts', 'C:/p/dir')).toBe('\\c.ts');
    expect(pathBelow('C:\\p\\dir\\c.ts', 'C:/p/dir/')).toBe('\\c.ts');
    expect(pathBelow('/w/dir/sub/c.ts', '/w/dir')).toBe('/sub/c.ts');
  });

  it('never matches a sibling that only shares a name prefix', () => {
    expect(pathBelow('C:\\p\\dir2\\c.ts', 'C:/p/dir')).toBeNull();
    expect(pathBelow('/w/a.tsx', '/w/a.ts')).toBeNull();
    expect(pathBelow('/w/b.ts', '/w/a.ts')).toBeNull();
  });
});

describe('renamedPath', () => {
  it('moves the renamed file itself, in the tab spelling', () => {
    expect(renamedPath('C:\\p\\a.ts', 'C:/p/a.ts', 'C:/p/b.ts')).toBe('C:\\p\\b.ts');
    expect(renamedPath('/w/a.ts', '/w/a.ts', '/w/b.ts')).toBe('/w/b.ts');
  });

  it('moves a file inside a renamed folder', () => {
    expect(renamedPath('C:\\p\\dir\\sub\\c.ts', 'C:/p/dir', 'C:/p/dir2')).toBe(
      'C:\\p\\dir2\\sub\\c.ts',
    );
    expect(renamedPath('/w/dir/c.ts', '/w/dir', '/w/other/dir')).toBe('/w/other/dir/c.ts');
  });

  it('leaves an unrelated path alone', () => {
    expect(renamedPath('C:\\p\\dir2\\c.ts', 'C:/p/dir', 'C:/p/x')).toBeNull();
  });
});
