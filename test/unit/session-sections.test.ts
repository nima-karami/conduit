import { describe, expect, it } from 'vitest';
import {
  folderForPath,
  missingTransitions,
  presentFolders,
  sessionSections,
} from '../../src/session-sections';

describe('sessionSections', () => {
  it('home first then roots in stored order, tags home/attached', () => {
    const out = sessionSections({ home: '/w/rmb', roots: ['/w/ci-image', '/w/api'] });
    expect(out.map((s) => [s.path, s.kind, s.name, s.label, s.missing])).toEqual([
      ['/w/rmb', 'home', 'rmb', 'rmb', false],
      ['/w/ci-image', 'attached', 'ci-image', 'ci-image', false],
      ['/w/api', 'attached', 'api', 'api', false],
    ]);
    expect(out[1].key).toBe('/w/ci-image');
  });

  it('missing attached flagged by key (casing differs)', () => {
    const out = sessionSections({
      home: 'C:\\Home',
      roots: ['C:\\Work\\A', 'C:\\Work\\B'],
      missingRoots: ['c:/work/b'],
    });
    expect(out.map((s) => s.missing)).toEqual([false, false, true]);
    expect(out[2].key).toBe('c:/work/b');
    expect(out[2].path).toBe('C:\\Work\\B');
  });

  it('homeMissing flags home', () => {
    const out = sessionSections({ home: '/w/h', roots: ['/w/a'], homeMissing: true });
    expect(out.map((s) => s.missing)).toEqual([true, false]);
  });

  it('basename collision → both get parentHint and label "name — parent"', () => {
    const out = sessionSections({ home: '/w/a/api', roots: ['/w/b/API', '/w/c/web'] });
    expect(out.map((s) => [s.name, s.parentHint, s.label])).toEqual([
      ['api', 'a', 'api — a'],
      ['API', 'b', 'API — b'],
      ['web', undefined, 'web'],
    ]);
  });

  it('no collision → no parentHint', () => {
    const out = sessionSections({ home: '/w/one', roots: ['/w/two'] });
    expect(out.every((s) => s.parentHint === undefined)).toBe(true);
    expect(out.every((s) => !('parentHint' in s))).toBe(true);
  });

  it('undefined session → []', () => {
    expect(sessionSections(undefined)).toEqual([]);
  });
});

describe('folderForPath', () => {
  it('folderForPath: longest containing folder wins; key equality counts; outside → undefined', () => {
    const folders = ['/w/home', '/w/home/nested', 'C:\\Att'];
    expect(folderForPath(folders, '/w/home/nested/x.ts')).toBe('/w/home/nested');
    expect(folderForPath(folders, '/w/home/src/x.ts')).toBe('/w/home');
    expect(folderForPath(folders, '/w/home')).toBe('/w/home');
    expect(folderForPath(folders, 'c:/att/lib/u.ts')).toBe('C:\\Att');
    expect(folderForPath(folders, 'c:\\ATT')).toBe('C:\\Att');
    expect(folderForPath(folders, '/w/homework/x')).toBeUndefined();
    expect(folderForPath([], '/w/home')).toBeUndefined();
  });
});

describe('missingTransitions', () => {
  it('missingTransitions: lost and back by key', () => {
    const prev = sessionSections({
      home: '/w/h',
      roots: ['/w/a', 'C:\\B'],
      missingRoots: ['c:/b'],
    });
    const next = sessionSections({ home: '/w/h', roots: ['/w/a', 'c:/b'], missingRoots: ['/w/a'] });
    expect(missingTransitions(prev, next)).toEqual({ lost: ['a'], back: ['b'] });
    expect(missingTransitions(next, next)).toEqual({ lost: [], back: [] });
  });

  it('folder removed entirely is neither', () => {
    const prev = sessionSections({ home: '/w/h', roots: ['/w/a'], missingRoots: ['/w/a'] });
    const next = sessionSections({ home: '/w/h', roots: [] });
    expect(missingTransitions(prev, next)).toEqual({ lost: [], back: [] });
    const added = sessionSections({ home: '/w/h', roots: ['/w/z'], missingRoots: ['/w/z'] });
    expect(missingTransitions(next, added)).toEqual({ lost: [], back: [] });
  });
});

describe('presentFolders', () => {
  it('presentFolders excludes missing home and missing roots; home first', () => {
    expect(presentFolders({ home: '/w/h', roots: ['/w/a', '/w/b'], missingRoots: ['/w/a'] })).toEqual([
      '/w/h',
      '/w/b',
    ]);
    expect(
      presentFolders({ home: '/w/h', roots: ['/w/a', '/w/b'], homeMissing: true }),
    ).toEqual(['/w/a', '/w/b']);
    expect(presentFolders(undefined)).toEqual([]);
  });
});
