import { describe, it, expect } from 'vitest';
import { langFromPath, isBinary, sortEntries } from '../../src/fileService';
import type { DirEntryDTO } from '../../src/protocol';

describe('fileService helpers', () => {
  it('infers Monaco language ids from extension', () => {
    expect(langFromPath('a/b.ts')).toBe('typescript');
    expect(langFromPath('x.TSX')).toBe('typescript');
    expect(langFromPath('readme.md')).toBe('markdown');
    expect(langFromPath('Makefile')).toBe('plaintext');
  });

  it('detects binary content via NUL bytes', () => {
    expect(isBinary(Buffer.from('hello world'))).toBe(false);
    expect(isBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('sorts directories first, then by name (case-insensitive)', () => {
    const input: DirEntryDTO[] = [
      { name: 'b.ts', kind: 'file' },
      { name: 'src', kind: 'dir' },
      { name: 'A.ts', kind: 'file' },
      { name: 'lib', kind: 'dir' },
    ];
    expect(sortEntries(input).map((e) => e.name)).toEqual(['lib', 'src', 'A.ts', 'b.ts']);
  });
});
