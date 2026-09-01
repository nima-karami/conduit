import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../../src/fuzzy';
import { type PaletteEntry, rankEntries } from '../../webview/components/command-palette';

const entry = (id: string, title: string, keywords?: string[]): PaletteEntry => ({
  id,
  title,
  group: 'Commands',
  keywords,
  run: () => {},
});

const ids = (rows: PaletteEntry[]) => rows.map((r) => r.id);

describe('rankEntries', () => {
  it('finds an entry by a keyword that is not a subsequence of its title', () => {
    const timed = entry('cmd:timedMessage', 'Send timed message…', ['interval', 'schedule']);
    expect(fuzzyScore('interval', timed.title)).toBeNull();
    expect(ids(rankEntries([entry('cmd:new', 'New session'), timed], 'interval'))).toEqual([
      'cmd:timedMessage',
    ]);
  });

  it('ranks a title match above a keyword match with a higher raw score', () => {
    // The keyword is an exact hit (big score) while the title is only a weak scattered
    // subsequence — the tier, not the score, has to decide.
    const kwOnly = entry('kw', 'Send timed message…', ['diff']);
    const titled = entry('title', 'Undiffuse the aggregate reporting pipeline');
    const kwScore = fuzzyScore('diff', 'diff')?.score ?? 0;
    const titleScore = fuzzyScore('diff', titled.title)?.score ?? 0;
    expect(titleScore).toBeLessThan(kwScore);
    expect(ids(rankEntries([kwOnly, titled], 'diff'))).toEqual(['title', 'kw']);
  });

  it('drops entries matching neither title nor keywords', () => {
    const rows = rankEntries(
      [entry('a', 'New session', ['create']), entry('b', 'Save All')],
      'zzqq',
    );
    expect(rows).toEqual([]);
  });

  it('ranks keyword-only matches among themselves by fuzzy score', () => {
    // 'timer' is exact on one, a scattered subsequence on the other.
    const exact = entry('exact', 'Alpha', ['timer']);
    const loose = entry('loose', 'Beta', ['optimizer']);
    expect(fuzzyScore('timer', 'optimizer')).not.toBeNull();
    expect(ids(rankEntries([loose, exact], 'timer'))).toEqual(['exact', 'loose']);
  });

  it('returns every entry, in source order, for an empty term', () => {
    const rows = [entry('a', 'New session', ['create']), entry('b', 'Save All'), entry('c', 'Zzz')];
    expect(ids(rankEntries(rows, ''))).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing keywords array as no keywords', () => {
    expect(rankEntries([entry('a', 'New session')], 'interval')).toEqual([]);
  });
});
