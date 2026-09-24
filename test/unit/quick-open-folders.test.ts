import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../../src/protocol';
import {
  acceptSearchResults,
  type FolderCorpus,
  foldersToRequest,
  pruneCorpus,
  quickOpenFileRows,
} from '../../src/quick-open-folders';
import { sessionSections } from '../../src/session-sections';

const hit = (root: string, rel: string): SearchHit => ({ rel, abs: `${root}/${rel}` });

describe('quick-open corpus', () => {
  it('foldersToRequest: only uncached present folders', () => {
    const corpus: FolderCorpus = { '/w/a': [] };
    expect(foldersToRequest(['/w/a', '/w/b', 'C:\\C'], corpus)).toEqual(['/w/b', 'C:\\C']);
    expect(foldersToRequest(['C:\\C'], { 'c:/c': [] })).toEqual([]);
  });

  it('accept keyed by folderKey; root not in folders ignored', () => {
    const c0: FolderCorpus = {};
    const c1 = acceptSearchResults(c0, { root: 'C:\\W\\A', results: [hit('C:/W/A', 'x.ts')] }, [
      'c:/w/a',
    ]);
    expect(c1).toEqual({ 'c:/w/a': [hit('C:/W/A', 'x.ts')] });
    expect(acceptSearchResults(c1, { root: '/elsewhere', results: [] }, ['c:/w/a'])).toBe(c1);
  });

  it('prune drops folders that left', () => {
    const c: FolderCorpus = { '/w/a': [hit('/w/a', 'x')], '/w/b': [hit('/w/b', 'y')] };
    expect(pruneCorpus(c, ['/w/a', '/w/b'])).toBe(c);
    const pruned = pruneCorpus(c, ['/w/a', '/w/new']);
    expect(pruned).toEqual({ '/w/a': [hit('/w/a', 'x')] });
    // A new or located folder is uncached, so it is requested next.
    expect(foldersToRequest(['/w/a', '/w/new'], pruned)).toEqual(['/w/new']);
  });

  it('rows: 1 section → no tag', () => {
    const secs = sessionSections({ home: '/w/rmb', roots: [] });
    const rows = quickOpenFileRows({ '/w/rmb': [hit('/w/rmb', 'a.ts')] }, secs);
    expect(rows).toEqual([{ hit: hit('/w/rmb', 'a.ts') }]);
    expect('tag' in rows[0]).toBe(false);
  });

  it('rows: 2+ sections → every row tagged; home accent, attached neutral; title = full path', () => {
    const secs = sessionSections({ home: '/w/rmb', roots: ['/w/ci-image'] });
    const rows = quickOpenFileRows(
      { '/w/rmb': [hit('/w/rmb', 'a.ts')], '/w/ci-image': [hit('/w/ci-image', 'lib/u.ts')] },
      secs,
    );
    expect(rows.map((r) => r.tag)).toEqual([
      { label: 'rmb', tone: 'accent', title: '/w/rmb' },
      { label: 'ci-image', tone: 'neutral', title: '/w/ci-image' },
    ]);
  });

  it('folder order then host order', () => {
    const secs = sessionSections({ home: '/w/h', roots: ['/w/a', '/w/b'], missingRoots: ['/w/a'] });
    const corpus: FolderCorpus = {
      '/w/b': [hit('/w/b', 'z'), hit('/w/b', 'y')],
      '/w/h': [hit('/w/h', 'q')],
      '/w/a': [hit('/w/a', 'stale')],
    };
    expect(quickOpenFileRows(corpus, secs).map((r) => r.hit.abs)).toEqual([
      '/w/h/q',
      '/w/b/z',
      '/w/b/y',
    ]);
  });
});
