import { describe, expect, it } from 'vitest';
import {
  addTrusted,
  isTrusted,
  parentFolder,
  parseTrustStore,
  removeTrusted,
  serializeTrustStore,
  type TrustStore,
} from '../../src/workspace-trust';

const empty: TrustStore = { trusted: [] };

describe('workspace trust store', () => {
  it('nothing is trusted by default', () => {
    expect(isTrusted(empty, 'C:\\w\\repo', 'win32')).toBe(false);
    expect(isTrusted(empty, '/w/repo', 'linux')).toBe(false);
  });

  it('a trusted folder covers itself and its descendants, not its siblings', () => {
    const s = addTrusted(empty, '/w/repo', 'linux');
    expect(isTrusted(s, '/w/repo', 'linux')).toBe(true);
    expect(isTrusted(s, '/w/repo/mod/sub', 'linux')).toBe(true);
    expect(isTrusted(s, '/w/repo2', 'linux')).toBe(false);
    expect(isTrusted(s, '/w', 'linux')).toBe(false);
  });

  it('trusting a parent trusts every child under it', () => {
    const s = addTrusted(empty, 'G:\\awby\\projects', 'win32');
    expect(isTrusted(s, 'G:\\awby\\projects\\conduit', 'win32')).toBe(true);
    expect(isTrusted(s, 'G:\\awby\\other', 'win32')).toBe(false);
  });

  it('win32 is canonical and case-insensitive; linux is case-sensitive', () => {
    const w = addTrusted(empty, 'g:/Awby/Repo/', 'win32');
    expect(w.trusted).toEqual(['G:\\Awby\\Repo']);
    expect(isTrusted(w, 'G:\\awby\\repo\\x', 'win32')).toBe(true);
    const l = addTrusted(empty, '/w/Repo', 'linux');
    expect(isTrusted(l, '/w/repo', 'linux')).toBe(false);
  });

  it('adding is idempotent and removal matches any spelling of the same folder', () => {
    let s = addTrusted(empty, 'C:\\w\\repo', 'win32');
    s = addTrusted(s, 'c:/W/REPO', 'win32');
    expect(s.trusted).toHaveLength(1);
    s = removeTrusted(s, 'c:\\w\\Repo\\', 'win32');
    expect(s.trusted).toEqual([]);
  });

  it('removing a child does not untrust it while a trusted parent still covers it', () => {
    let s = addTrusted(empty, '/w', 'linux');
    s = addTrusted(s, '/w/repo', 'linux');
    s = removeTrusted(s, '/w/repo', 'linux');
    expect(isTrusted(s, '/w/repo', 'linux')).toBe(true);
  });

  it('never mutates its input', () => {
    const s = Object.freeze({ trusted: Object.freeze(['/a']) as unknown as string[] });
    addTrusted(s, '/b', 'linux');
    removeTrusted(s, '/a', 'linux');
    expect(s.trusted).toEqual(['/a']);
  });

  it('only absolute paths without . or .. segments are admitted', () => {
    expect(addTrusted(empty, 'relative/dir', 'linux').trusted).toEqual([]);
    expect(addTrusted(empty, '/w/../etc', 'linux').trusted).toEqual([]);
    expect(addTrusted(empty, 'C:repo', 'win32').trusted).toEqual([]);
    expect(isTrusted({ trusted: ['/w'] }, '/w/../etc', 'linux')).toBe(false);
  });

  it('parentFolder is the directory above, null at a root', () => {
    expect(parentFolder('G:\\awby\\projects\\conduit', 'win32', 'C:\\Users\\n')).toBe(
      'G:\\awby\\projects',
    );
    expect(parentFolder('/home/n/code/repo', 'linux', '/home/n')).toBe('/home/n/code');
    expect(parentFolder('G:\\', 'win32', 'C:\\Users\\n')).toBeNull();
    expect(parentFolder('/', 'linux', '/home/n')).toBeNull();
  });

  it('never offers a filesystem root or the home directory as the parent to trust', () => {
    expect(parentFolder('G:\\repo', 'win32', 'C:\\Users\\n')).toBeNull();
    expect(parentFolder('/repo', 'linux', '/home/n')).toBeNull();
    expect(parentFolder('\\\\srv\\share\\repo', 'win32', 'C:\\Users\\n')).toBeNull();
    expect(parentFolder('/home/n/repo', 'linux', '/home/n')).toBeNull();
    expect(parentFolder('c:\\users\\N\\repo', 'win32', 'C:\\Users\\n\\')).toBeNull();
    expect(parentFolder('/home/n/repo', 'linux', '/home/N')).toBe('/home/n');
  });

  it('never offers a parent that contains the home directory (every user’s home)', () => {
    expect(parentFolder('C:\\Users\\n', 'win32', 'C:\\Users\\n')).toBeNull();
    expect(parentFolder('/home/n', 'linux', '/home/n')).toBeNull();
    expect(parentFolder('/Users/n', 'darwin', '/Users/n')).toBeNull();
    expect(parentFolder('D:\\data\\home', 'win32', 'D:\\data\\home\\n')).toBeNull();
    expect(parentFolder('C:\\Users\\n\\code\\repo', 'win32', 'C:\\Users\\n')).toBe(
      'C:\\Users\\n\\code',
    );
  });

  it('a \\\\?\\ long-path spelling is the same folder, so it cannot slip past the bounds', () => {
    expect(parentFolder('\\\\?\\C:\\Users\\n\\repo', 'win32', 'C:\\Users\\n')).toBeNull();
    expect(parentFolder('\\\\?\\C:\\Users\\n', 'win32', 'C:\\Users\\n')).toBeNull();
    const s = addTrusted({ trusted: [] }, '\\\\?\\c:\\w\\repo', 'win32');
    expect(s.trusted).toEqual(['C:\\w\\repo']);
    expect(isTrusted(s, 'C:\\w\\repo\\x', 'win32')).toBe(true);
  });

  it('parse drops anything that is not a trusted-folder list and round-trips the rest', () => {
    expect(parseTrustStore('not json', 'linux')).toEqual(empty);
    expect(parseTrustStore('{"trusted": "x"}', 'linux')).toEqual(empty);
    expect(parseTrustStore('{"trusted": ["/w", 3, "rel", "/w/../x"]}', 'linux')).toEqual({
      trusted: ['/w'],
    });
    const s = addTrusted(empty, 'C:\\a b\\c', 'win32');
    expect(parseTrustStore(serializeTrustStore(s), 'win32')).toEqual(s);
  });
});
