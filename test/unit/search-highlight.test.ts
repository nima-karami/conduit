import { describe, expect, it } from 'vitest';
import { highlightSegments } from '../../webview/search-highlight';

describe('highlightSegments', () => {
  it('splits a line into plain + hit segments', () => {
    const segs = highlightSegments('the cat sat', { text: 'cat' });
    expect(segs).toEqual([
      { text: 'the ', hit: false },
      { text: 'cat', hit: true },
      { text: ' sat', hit: false },
    ]);
  });

  it('highlights every occurrence', () => {
    const segs = highlightSegments('ab ab', { text: 'ab' });
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['ab', 'ab']);
  });

  it('preserves original casing of the matched text (case-insensitive)', () => {
    const segs = highlightSegments('Foo bar', { text: 'foo' });
    expect(segs[0]).toEqual({ text: 'Foo', hit: true });
  });

  it('returns a single plain segment for a blank query', () => {
    expect(highlightSegments('hello', { text: '' })).toEqual([{ text: 'hello', hit: false }]);
  });

  it('does not throw on an invalid regex (falls back to plain)', () => {
    expect(highlightSegments('hello', { text: '(', regex: true })).toEqual([
      { text: 'hello', hit: false },
    ]);
  });
});
