import { describe, expect, it } from 'vitest';
import { downloadUrlFor, fileUrlFor } from '../../src/download-url';

describe('fileUrlFor', () => {
  it('drive path: forward slashes, segments percent-encoded', () => {
    expect(fileUrlFor('C:\\a b\\c#1.txt')).toBe('file:///C:/a%20b/c%231.txt');
  });

  it('mixed separators (tree rows join with /) give one form', () => {
    expect(fileUrlFor('C:\\proj/sub/a.txt')).toBe('file:///C:/proj/sub/a.txt');
  });

  it('posix path, non-ASCII encoded as UTF-8', () => {
    expect(fileUrlFor('/a/日.txt')).toBe('file:///a/%E6%97%A5.txt');
  });

  it('UNC path puts the server in the host', () => {
    expect(fileUrlFor('\\\\srv\\share\\f')).toBe('file://srv/share/f');
  });
});

describe('downloadUrlFor', () => {
  it('builds the Chromium DownloadURL triple', () => {
    expect(downloadUrlFor('C:\\x\\y.txt')).toBe(
      'application/octet-stream:y.txt:file:///C:/x/y.txt',
    );
  });

  it('a name containing ":" cannot be expressed → null', () => {
    expect(downloadUrlFor('/a/b:c')).toBeNull();
  });

  it('relative path → null', () => {
    expect(downloadUrlFor('a/b.txt')).toBeNull();
    expect(downloadUrlFor('b.txt')).toBeNull();
  });

  it('a root or trailing separator has no file name → null', () => {
    expect(downloadUrlFor('/')).toBeNull();
    expect(downloadUrlFor('C:\\x\\')).toBeNull();
  });
});
