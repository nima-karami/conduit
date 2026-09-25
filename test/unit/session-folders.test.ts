import { describe, expect, it } from 'vitest';
import {
  presentRoots,
  sessionContains,
  sessionHasFolderKey,
  watchFoldersFor,
} from '../../src/session-folders';
import type { Session } from '../../src/types';

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's',
    name: 's',
    agentId: 'claude',
    home: 'C:\\w\\home',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...over,
  };
}

describe('session-folders', () => {
  it('presentRoots excludes missing by key', () => {
    const s = session({ roots: ['C:\\w\\a', 'C:\\w\\b', 'C:\\w\\c'], missingRoots: ['c:/w/B/'] });
    expect(presentRoots(s)).toEqual(['C:\\w\\a', 'C:\\w\\c']);
    expect(presentRoots(session({ roots: ['/r/a'] }))).toEqual(['/r/a']);
  });

  it('watchFoldersFor: p, home, present roots; home omitted when homeMissing; no session → [p]', () => {
    const s = session({ roots: ['C:\\w\\a', 'C:\\w\\b'], missingRoots: ['C:\\w\\b'] });
    expect(watchFoldersFor('C:\\w\\home\\sub', s)).toEqual([
      'C:\\w\\home\\sub',
      'C:\\w\\home',
      'C:\\w\\a',
    ]);
    expect(watchFoldersFor('C:\\w\\home', { ...s, homeMissing: true })).toEqual([
      'C:\\w\\home',
      'C:\\w\\a',
    ]);
    expect(watchFoldersFor('/p', undefined)).toEqual(['/p']);
    expect(watchFoldersFor('', undefined)).toEqual([]);
    expect(watchFoldersFor('', s)).toEqual(['C:\\w\\home', 'C:\\w\\a']);
  });

  it('sessionHasFolderKey home and roots', () => {
    const s = session({ roots: ['/r/Attached'] });
    expect(sessionHasFolderKey(s, 'c:/w/home')).toBe(true);
    expect(sessionHasFolderKey(s, '/r/Attached')).toBe(true);
    expect(sessionHasFolderKey(s, '/r/attached')).toBe(false);
    expect(sessionHasFolderKey(s, 'c:/w/home/sub')).toBe(false);
  });

  it('sessionContains a path inside an attached root', () => {
    const s = session({ roots: ['/r/att'] });
    expect(sessionContains(s, '/r/att/deep/file.ts')).toBe(true);
    expect(sessionContains(s, '/r/att')).toBe(true);
    expect(sessionContains(s, 'c:\\W\\HOME\\x')).toBe(true);
    expect(sessionContains(s, '/r/attic')).toBe(false);
    expect(sessionContains(s, '/r')).toBe(false);
  });
});
