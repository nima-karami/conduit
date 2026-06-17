import { describe, expect, it } from 'vitest';
import {
  appendScrollback,
  type PersistedScrollback,
  restoreScrollback,
  SCROLLBACK_CAP_BYTES,
  serializeScrollback,
} from '../../src/scrollback-persistence';

describe('scrollback-persistence', () => {
  it('accumulates chunks below the cap', () => {
    let s = '';
    s = appendScrollback(s, 'foo', SCROLLBACK_CAP_BYTES);
    s = appendScrollback(s, 'bar', SCROLLBACK_CAP_BYTES);
    expect(s).toBe('foobar');
  });

  it('keeps only the trailing cap chars (newest-wins) when over cap', () => {
    const cap = 10;
    let s = '';
    s = appendScrollback(s, '0123456789', cap);
    s = appendScrollback(s, 'ABCDE', cap);
    expect(s.length).toBe(cap);
    expect(s).toBe('56789ABCDE');
  });

  it('truncates a single chunk larger than the cap to its trailing bytes', () => {
    const cap = 4;
    const s = appendScrollback('', 'abcdefgh', cap);
    expect(s).toBe('efgh');
  });

  it('round-trips serialize -> restore', () => {
    const p: PersistedScrollback = {
      version: 1,
      sessionId: 's1',
      data: 'line1\r\n\x1b[2mdim\x1b[0m\r\n',
    };
    const restored = restoreScrollback(serializeScrollback(p));
    expect(restored).toEqual(p);
  });

  it('returns null on missing or garbage input', () => {
    expect(restoreScrollback(undefined)).toBeNull();
    expect(restoreScrollback('not json')).toBeNull();
    expect(restoreScrollback('{"version":2,"sessionId":"s","data":"x"}')).toBeNull();
    expect(restoreScrollback('{"version":1,"sessionId":"s"}')).toBeNull();
    expect(restoreScrollback('[]')).toBeNull();
  });
});
