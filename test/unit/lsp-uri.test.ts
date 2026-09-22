import { describe, expect, it } from 'vitest';
import { fileUriToPath, pathToFileUri } from '../../src/lsp-uri';

describe('pathToFileUri', () => {
  it('upper-cases the drive and flips separators', () => {
    expect(pathToFileUri('g:\\a b\\c#.go')).toBe('file:///G:/a%20b/c%23.go');
    expect(pathToFileUri('g:/a/b.go')).toBe('file:///G:/a/b.go');
  });

  it('POSIX path', () => {
    expect(pathToFileUri('/home/x/ü.go')).toBe('file:///home/x/%C3%BC.go');
  });

  it('encodes a literal percent', () => {
    expect(pathToFileUri('C:\\pct%20dir\\a.go')).toBe('file:///C:/pct%2520dir/a.go');
  });

  it('UNC becomes an authority', () => {
    expect(pathToFileUri('\\\\srv\\share\\x.go')).toBe('file://srv/share/x.go');
  });
});

describe('fileUriToPath', () => {
  it('reverse accepts every drive spelling', () => {
    for (const uri of ['file:///c%3A/x/y.go', 'file:///c:/x/y.go', 'file:///C:/x/y.go']) {
      expect(fileUriToPath(uri)).toBe('C:\\x\\y.go');
    }
  });

  it('decodes percent-encoded segments', () => {
    expect(fileUriToPath('file:///G:/a%20b/c%23.go')).toBe('G:\\a b\\c#.go');
    expect(fileUriToPath('file:///home/x/%C3%BC.go')).toBe('/home/x/ü.go');
  });

  it('UNC round-trips', () => {
    const p = '\\\\srv\\share\\dir\\x.go';
    expect(fileUriToPath('file://srv/share/dir/x.go')).toBe(p);
    expect(fileUriToPath(pathToFileUri(p))).toBe(p);
  });

  it('non-file is null', () => {
    expect(fileUriToPath('https://pkg.go.dev/fmt')).toBeNull();
    expect(fileUriToPath('untitled:1')).toBeNull();
    expect(fileUriToPath('file:///bad%zz')).toBeNull();
  });

  it('round trip is identity for canonical paths', () => {
    for (const p of ['C:\\a b\\x#.go', 'G:\\pct%20dir\\q?.go', '/home/n/ü x.go', 'D:\\']) {
      expect(fileUriToPath(pathToFileUri(p))).toBe(p);
    }
  });
});
