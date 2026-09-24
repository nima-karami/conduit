import { describe, expect, it } from 'vitest';
import type { SearchFileResult } from '../../src/content-search';
import {
  acceptFolderReply,
  IDLE_SEARCH,
  isSearching,
  multiSearchSummary,
  retainFolders,
  searchableFolders,
  searchFolderGroups,
  startMultiSearch,
  timeOutSearch,
} from '../../src/folder-search';
import { sessionSections } from '../../src/session-sections';

const file = (rel: string, lines: number): SearchFileResult => ({
  rel,
  abs: `/x/${rel}`,
  matches: Array.from({ length: lines }, (_, i) => ({
    line: i + 1,
    column: 1,
    lineText: 'x',
  })),
});
const reply = (requestId: number, root: string, results: SearchFileResult[], extra = {}) => ({
  requestId,
  root,
  results,
  truncated: false,
  ...extra,
});

describe('searchableFolders', () => {
  it('searchableFolders drops missing home and missing attached, keeps order', () => {
    const secs = sessionSections({
      home: '/w/h',
      roots: ['/w/a', '/w/b', '/w/c'],
      missingRoots: ['/w/b'],
      homeMissing: true,
    });
    expect(searchableFolders(secs).map((s) => s.path)).toEqual(['/w/a', '/w/c']);
  });
});

describe('multi-folder search reducer', () => {
  it('IDLE_SEARCH is not searching', () => {
    expect(IDLE_SEARCH).toEqual({ requestId: 0, expected: [], replies: {}, timedOut: false });
    expect(isSearching(IDLE_SEARCH)).toBe(false);
  });

  it('searching until every expected folder replied', () => {
    let s = startMultiSearch(4, ['/w/a', '/w/b']);
    expect(isSearching(s)).toBe(true);
    s = acceptFolderReply(s, reply(4, '/w/a', [file('x.ts', 1)]));
    expect(isSearching(s)).toBe(true);
    s = acceptFolderReply(s, reply(4, '/w/b', []));
    expect(isSearching(s)).toBe(false);
  });

  it('stale requestId dropped (same object)', () => {
    const s = startMultiSearch(4, ['/w/a']);
    expect(acceptFolderReply(s, reply(3, '/w/a', [file('x.ts', 1)]))).toBe(s);
  });

  it('reply for a root not expected dropped', () => {
    const s = startMultiSearch(4, ['/w/a']);
    expect(acceptFolderReply(s, reply(4, '/w/zzz', []))).toBe(s);
  });

  it('root casing differs → accepted by key', () => {
    const s = startMultiSearch(1, ['c:/w/a']);
    const next = acceptFolderReply(s, reply(1, 'C:\\W\\A', [file('x.ts', 2)]));
    expect(next).not.toBe(s);
    expect(isSearching(next)).toBe(false);
    expect(searchFolderGroups(next).map((g) => [g.key, g.resultCount])).toEqual([['c:/w/a', 2]]);
  });

  it('retainFolders drops a removed folder and stops waiting for it', () => {
    let s = startMultiSearch(2, ['/w/a', '/w/b']);
    s = acceptFolderReply(s, reply(2, '/w/b', [file('y.ts', 1)]));
    const kept = retainFolders(s, ['/w/a']);
    expect(kept.expected).toEqual(['/w/a']);
    expect(kept.replies).toEqual({});
    expect(retainFolders(s, ['/w/a', '/w/b'])).toBe(s);
    const done = retainFolders(startMultiSearch(2, ['/w/a', '/w/b']), ['/w/b']);
    expect(isSearching(acceptFolderReply(done, reply(2, '/w/b', [])))).toBe(false);
  });

  it('timeOut: unreplied folders get "Search timed out. Try again."; arrived results kept', () => {
    let s = startMultiSearch(5, ['/w/a', '/w/b']);
    s = acceptFolderReply(s, reply(5, '/w/a', [file('x.ts', 3)]));
    s = timeOutSearch(s);
    expect(isSearching(s)).toBe(false);
    expect(searchFolderGroups(s)).toEqual([
      { key: '/w/a', results: [file('x.ts', 3)], resultCount: 3 },
      { key: '/w/b', results: [], resultCount: 0, note: 'Search timed out. Try again.' },
    ]);
  });

  it('error / truncated notes per folder', () => {
    let s = startMultiSearch(6, ['/w/a', '/w/b', '/w/c']);
    s = acceptFolderReply(s, reply(6, '/w/a', [file('x.ts', 1)], { truncated: true }));
    s = acceptFolderReply(s, reply(6, '/w/b', [], { error: 'Invalid regular expression' }));
    s = acceptFolderReply(s, reply(6, '/w/c', []));
    expect(searchFolderGroups(s).map((g) => [g.key, g.note])).toEqual([
      ['/w/a', 'Partial (limit reached)'],
      ['/w/b', 'Invalid regular expression'],
    ]);
  });

  it('groups in expected order; empty folders omitted unless noted', () => {
    let s = startMultiSearch(7, ['/w/a', '/w/b', '/w/c']);
    s = acceptFolderReply(s, reply(7, '/w/c', [file('c.ts', 1)]));
    s = acceptFolderReply(s, reply(7, '/w/b', []));
    s = acceptFolderReply(s, reply(7, '/w/a', [file('a.ts', 1), file('b.ts', 0)]));
    const groups = searchFolderGroups(s);
    expect(groups.map((g) => g.key)).toEqual(['/w/a', '/w/c']);
    // A name-only hit counts as one result.
    expect(groups[0].resultCount).toBe(2);
  });

  it('summary "5 results in 3 files · 2 folders"; singular forms', () => {
    let s = startMultiSearch(8, ['/w/a', '/w/b']);
    s = acceptFolderReply(s, reply(8, '/w/a', [file('x.ts', 2), file('y.ts', 1)]));
    s = acceptFolderReply(s, reply(8, '/w/b', [file('z.ts', 2)]));
    expect(multiSearchSummary(searchFolderGroups(s))).toBe('5 results in 3 files · 2 folders');
    let one = startMultiSearch(9, ['/w/a', '/w/b']);
    one = acceptFolderReply(one, reply(9, '/w/a', [file('x.ts', 1)]));
    one = timeOutSearch(one);
    expect(multiSearchSummary(searchFolderGroups(one))).toBe('1 result in 1 file · 1 folder');
  });
});
