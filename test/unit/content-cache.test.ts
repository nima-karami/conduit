import { describe, expect, it } from 'vitest';
import {
  evictOldest,
  forgetEvictedRequests,
  pruneDiffs,
  pruneFiles,
  rereadsOnFocus,
  setNewest,
} from '../../webview/content-cache';
import type { OpenDoc } from '../../webview/docs';
import { createIdleLru } from '../../webview/idle-model-lru';

const doc = (kind: OpenDoc['kind'], path: string, extra: Partial<OpenDoc> = {}): OpenDoc => ({
  id: `${kind}:${path}`,
  kind,
  path,
  title: path,
  sessionId: 's',
  ...extra,
});

describe('pruneFiles', () => {
  it('drops entries no open file tab shows, keeps the rest', () => {
    const files = new Map([
      ['/a', 1],
      ['/b', 2],
    ]);
    const next = pruneFiles(files, [doc('file', '/a'), doc('diff', '/b')]);
    expect([...next.keys()]).toEqual(['/a']);
  });
  it('returns the same map when nothing goes', () => {
    const files = new Map([['/a', 1]]);
    expect(pruneFiles(files, [doc('file', '/a')])).toBe(files);
  });
  it('keeps a path shown in a second session', () => {
    const files = new Map([['/a', 1]]);
    const docs = [doc('file', '/a', { sessionId: 'x' }), doc('file', '/a', { sessionId: 'y' })];
    expect(pruneFiles(files, docs)).toBe(files);
  });
});

describe('pruneDiffs', () => {
  const diffs = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`/f${i}`, i]));
  it('caps non-open entries to the newest max, oldest out first', () => {
    const next = pruneDiffs(diffs(5), [], 2);
    expect([...next.keys()]).toEqual(['/f3', '/f4']);
  });
  it('never drops an open diff tab entry, even over the cap', () => {
    const next = pruneDiffs(
      diffs(5),
      [doc('diff', '/f0'), doc('diff', '/f1', { diffScope: 'staged' })],
      1,
    );
    expect([...next.keys()]).toEqual(['/f0', '/f4']);
  });
  it('keys a scoped tab by its scope', () => {
    const m = new Map([['staged\u0000/f1', 1]]);
    expect(pruneDiffs(m, [doc('diff', '/f1', { diffScope: 'staged' })], 0)).toBe(m);
  });
  it('returns the same map under the cap', () => {
    const m = diffs(3);
    expect(pruneDiffs(m, [], 3)).toBe(m);
  });
});

describe('setNewest', () => {
  it('moves a re-set key to the newest end', () => {
    const m = setNewest(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
      'a',
      3,
    );
    expect([...m.keys()]).toEqual(['b', 'a']);
  });
});

describe('evictOldest', () => {
  it('evicts oldest over max but never a pinned key', () => {
    const c = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
    ]);
    evictOldest(c, 2, (k) => k === 'a');
    expect([...c.keys()]).toEqual(['a', 'd']);
  });
});

describe('rereadsOnFocus', () => {
  it('skips images and PDFs, rereads text and unknowns', () => {
    expect(rereadsOnFocus({ image: {} })).toBe(false);
    expect(rereadsOnFocus({ pdf: {} })).toBe(false);
    expect(rereadsOnFocus({})).toBe(true);
    expect(rereadsOnFocus(undefined)).toBe(true);
  });
});

describe('forgetEvictedRequests', () => {
  it('clears the guard for a diff that was present and is gone, keeps in-flight ones', () => {
    const requested = new Set(['/a', '/b']);
    const settled = new Set<string>();
    forgetEvictedRequests(requested, settled, new Map([['/a', 1]]));
    expect([...requested]).toEqual(['/a', '/b']);
    forgetEvictedRequests(requested, settled, new Map());
    expect([...requested]).toEqual(['/b']);
  });
});

describe('createIdleLru', () => {
  it('evicts the oldest idle over the cap; a re-activated key is spared', () => {
    const out: string[] = [];
    const lru = createIdleLru<string>(2, (k) => out.push(k));
    lru.markIdle('a');
    lru.markIdle('b');
    lru.markActive('a');
    lru.markIdle('c');
    lru.markIdle('d');
    expect(out).toEqual(['b']);
    expect(lru.size()).toBe(2);
  });
});
