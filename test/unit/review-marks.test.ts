import { describe, expect, it } from 'vitest';
import {
  applyMarksPush,
  contentHash,
  emptyMarksFile,
  MAX_MARKS_PER_REPO,
  marksFor,
  normalizeRoot,
  parseMarksFile,
  type ReviewMark,
  reviewedPaths,
  serializeMarksFile,
  setMark,
  setMarkList,
  staleMarks,
} from '../../src/review-marks';

const mark = (over: Partial<ReviewMark> = {}): ReviewMark => ({
  source: 'working',
  path: 'src/a.ts',
  contentHash: 'deadbeef',
  at: '2026-08-27T10:00:00.000Z',
  ...over,
});

describe('contentHash', () => {
  it('is stable, 8 hex chars, and differs for different text', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hellp'));
  });

  it('notices a whitespace-only difference — a re-indent IS a change to a mark', () => {
    expect(contentHash('  a\n')).not.toBe(contentHash('\ta\n'));
  });

  it('hashes the empty string without throwing', () => {
    expect(contentHash('')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is not platform-dependent: it reads UTF-16 units, never bytes', () => {
    expect(contentHash('é')).toBe(contentHash('\u00e9'));
  });
});

describe('normalizeRoot', () => {
  it('makes a windows root posix and drops a trailing separator', () => {
    expect(normalizeRoot('C:\\work\\repo\\')).toBe('C:/work/repo');
    expect(normalizeRoot('/home/u/repo/')).toBe('/home/u/repo');
  });
});

describe('parseMarksFile / serializeMarksFile', () => {
  it('round-trips', () => {
    const file = setMark(emptyMarksFile(), '/repo', mark(), true);
    expect(parseMarksFile(serializeMarksFile(file))).toEqual(file);
  });

  it('treats absent, empty, malformed and wrong-version blobs as empty', () => {
    expect(parseMarksFile(undefined)).toEqual(emptyMarksFile());
    expect(parseMarksFile('')).toEqual(emptyMarksFile());
    expect(parseMarksFile('{oh no')).toEqual(emptyMarksFile());
    expect(parseMarksFile('[]')).toEqual(emptyMarksFile());
    expect(parseMarksFile(JSON.stringify({ version: 2, repos: {} }))).toEqual(emptyMarksFile());
  });

  it('drops entries that are not marks and keeps the rest of the repo', () => {
    const blob = JSON.stringify({
      version: 1,
      repos: { '/repo': [mark(), { path: 'b.ts' }, null, 'nope'] },
    });
    expect(marksFor(parseMarksFile(blob), '/repo')).toEqual([mark()]);
  });

  it('normalises repo keys on read so a windows root can only be stored once', () => {
    const blob = JSON.stringify({ version: 1, repos: { 'C:\\work\\repo': [mark()] } });
    expect(marksFor(parseMarksFile(blob), 'C:/work/repo')).toEqual([mark()]);
  });

  it('caps an over-long repo on read, newest first', () => {
    const many = Array.from({ length: MAX_MARKS_PER_REPO + 5 }, (_, i) =>
      mark({ path: `f${i}.ts`, at: `2026-08-27T10:00:${String(i % 60).padStart(2, '0')}.000Z` }),
    );
    const parsed = parseMarksFile(JSON.stringify({ version: 1, repos: { '/repo': many } }));
    expect(marksFor(parsed, '/repo')).toHaveLength(MAX_MARKS_PER_REPO);
  });
});

describe('setMarkList', () => {
  it('adds a mark', () => {
    expect(setMarkList([], mark(), true)).toEqual([mark()]);
  });

  it('replaces the existing mark for the same source+path rather than duplicating it', () => {
    const next = setMarkList([mark()], mark({ contentHash: 'cafe0000', at: 'z' }), true);
    expect(next).toHaveLength(1);
    expect(next[0].contentHash).toBe('cafe0000');
  });

  it('keeps the same path under a different source as a separate mark', () => {
    const next = setMarkList([mark()], mark({ source: 'commit:abc' }), true);
    expect(next).toHaveLength(2);
  });

  it('removes a mark, matching on source+path only', () => {
    expect(setMarkList([mark()], mark({ contentHash: 'whatever' }), false)).toEqual([]);
  });

  it('removing something absent is a no-op', () => {
    expect(setMarkList([mark()], mark({ path: 'other.ts' }), false)).toEqual([mark()]);
  });

  it('keeps the NEWEST 2 000 when the cap is exceeded', () => {
    const old = Array.from({ length: MAX_MARKS_PER_REPO }, (_, i) =>
      mark({ path: `f${i}.ts`, at: '2020-01-01T00:00:00.000Z' }),
    );
    const next = setMarkList(old, mark({ path: 'fresh.ts', at: '2030-01-01T00:00:00.000Z' }), true);
    expect(next).toHaveLength(MAX_MARKS_PER_REPO);
    expect(next.some((m) => m.path === 'fresh.ts')).toBe(true);
  });
});

describe('setMark', () => {
  it('keys repos by their normalised root', () => {
    const file = setMark(emptyMarksFile(), 'C:\\work\\repo\\', mark(), true);
    expect(Object.keys(file.repos)).toEqual(['C:/work/repo']);
  });

  it('does not mutate the file it was given', () => {
    const before = emptyMarksFile();
    setMark(before, '/repo', mark(), true);
    expect(before.repos).toEqual({});
  });

  it('drops a repo key once its last mark is cleared', () => {
    const one = setMark(emptyMarksFile(), '/repo', mark(), true);
    expect(setMark(one, '/repo', mark(), false).repos).toEqual({});
  });
});

describe('reviewedPaths / staleMarks', () => {
  const marks = [
    mark({ path: 'a.ts', contentHash: 'aaaa1111' }),
    mark({ path: 'b.ts', contentHash: 'bbbb2222' }),
    mark({ path: 'c.ts', contentHash: 'cccc3333', source: 'commit:abc' }),
  ];
  const hashes = new Map([
    ['a.ts', 'aaaa1111'],
    ['b.ts', 'CHANGED0'],
  ]);

  it('counts only marks of THIS source whose hash still matches', () => {
    expect([...reviewedPaths(marks, 'working', hashes)]).toEqual(['a.ts']);
  });

  it('an unloaded file (no hash yet) is neither reviewed nor stale', () => {
    expect(reviewedPaths(marks, 'commit:abc', new Map()).size).toBe(0);
    expect(staleMarks(marks, 'commit:abc', new Map())).toEqual([]);
  });

  it('reports exactly the marks whose loaded file has changed since', () => {
    expect(staleMarks(marks, 'working', hashes).map((m) => m.path)).toEqual(['b.ts']);
  });
});

describe('applyMarksPush', () => {
  it('replaces the pushed roots and leaves the others alone', () => {
    const before = new Map<string, readonly ReviewMark[]>([
      ['/one', [mark()]],
      ['/two', [mark({ path: 'x.ts' })]],
    ]);
    const after = applyMarksPush(before, [{ root: '/one', marks: [] }]);
    expect(after.get('/one')).toEqual([]);
    expect(after.get('/two')).toEqual([mark({ path: 'x.ts' })]);
  });

  it('normalises the pushed root', () => {
    const after = applyMarksPush(new Map(), [{ root: 'C:\\work\\repo', marks: [mark()] }]);
    expect(after.get('C:/work/repo')).toEqual([mark()]);
  });

  it('an empty push is still a push — it returns a map, not the same reference', () => {
    const before = new Map<string, readonly ReviewMark[]>();
    expect(applyMarksPush(before, [])).not.toBe(before);
  });
});
