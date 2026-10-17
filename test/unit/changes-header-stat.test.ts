import { describe, expect, it } from 'vitest';
import { staleRowText } from '../../webview/components/changes-view';
import { headerStat, headerStatText } from '../../webview/components/lines-pending';

describe('headerStat (engine runtime QA2)', () => {
  it('is the placeholder alone while any repo in scope is counting', () => {
    const stat = headerStat(true, 3, 1);
    expect(stat).toEqual({ pending: true });
    expect(headerStatText(stat)).toBe('');
  });

  it('is the full total once every repo has counted', () => {
    const stat = headerStat(false, 3, 1);
    expect(stat).toEqual({ pending: false, added: 3, removed: 1 });
    expect(headerStatText(stat)).toBe('+3 -1');
    expect(headerStatText(headerStat(false, 0, 0))).toBe('');
  });
});

describe('staleRowText (engine runtime QA1)', () => {
  const now = 1_000_000_000;

  it('says only "Updating…" while the last read is under a minute old', () => {
    expect(staleRowText(now - 5_000, now)).toBe('Updating…');
    expect(staleRowText(now - 59_999, now)).toBe('Updating…');
  });

  it('adds the relative age of the last read from a minute on', () => {
    expect(staleRowText(now - 60_000, now)).toBe('Updating… · last read 1 min ago');
    expect(staleRowText(now - 5 * 60_000, now)).toBe('Updating… · last read 5 mins ago');
  });
});
