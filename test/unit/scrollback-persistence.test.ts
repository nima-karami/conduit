import { describe, expect, it } from 'vitest';
import {
  appendScrollback,
  appendToRing,
  attachReplay,
  coldReplay,
  type PersistedScrollback,
  REPLAY_MODE_NEUTRALIZER,
  restoreScrollback,
  SCROLLBACK_CAP_BYTES,
  type ScrollbackRing,
  scrollbackReplayPadding,
  serializeScrollback,
} from '../../src/scrollback-persistence';

const A = { cols: 120, rows: 30 };
const B = { cols: 90, rows: 20 };

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

  describe('appendToRing', () => {
    it('extends the last segment while the size is unchanged', () => {
      let ring: ScrollbackRing = [];
      ring = appendToRing(ring, 'foo', A, 100);
      ring = appendToRing(ring, 'bar', { ...A }, 100);
      expect(ring).toEqual([{ data: 'foobar', geometry: A }]);
    });

    it('starts a new segment when the size changes, and again when it changes back', () => {
      let ring: ScrollbackRing = [];
      ring = appendToRing(ring, 'a', A, 100);
      ring = appendToRing(ring, 'b', B, 100);
      ring = appendToRing(ring, 'c', A, 100);
      expect(ring).toEqual([
        { data: 'a', geometry: A },
        { data: 'b', geometry: B },
        { data: 'c', geometry: A },
      ]);
    });

    it('starts a new segment after a restored segment with no geometry', () => {
      const ring = appendToRing([{ data: 'v1' }], 'new', A, 100);
      expect(ring).toEqual([{ data: 'v1' }, { data: 'new', geometry: A }]);
    });

    it('trims from the head across segments; a partly trimmed head keeps its geometry', () => {
      let ring: ScrollbackRing = [];
      ring = appendToRing(ring, '0123', A, 10);
      ring = appendToRing(ring, '4567', B, 10);
      ring = appendToRing(ring, '89ABC', A, 10);
      expect(ring).toEqual([
        { data: '3', geometry: A },
        { data: '4567', geometry: B },
        { data: '89ABC', geometry: A },
      ]);
      ring = appendToRing(ring, 'DEFGH', A, 10);
      expect(ring).toEqual([{ data: '89ABCDEFGH', geometry: A }]);
    });

    it('keeps only the trailing cap chars of a single oversized chunk', () => {
      expect(appendToRing([{ data: 'old', geometry: B }], 'abcdefgh', A, 4)).toEqual([
        { data: 'efgh', geometry: A },
      ]);
    });

    it('does not mutate the ring it is given', () => {
      const ring: ScrollbackRing = [{ data: 'x', geometry: A }];
      appendToRing(ring, 'y', A, 100);
      expect(ring).toEqual([{ data: 'x', geometry: A }]);
    });
  });

  describe('coldReplay', () => {
    it('is empty for an empty ring', () => {
      expect(coldReplay([])).toEqual({ data: '', runs: [] });
      expect(coldReplay([{ data: '', geometry: A }])).toEqual({ data: '', runs: [] });
    });

    it('is exactly the ring plus the tail, each run at its size, the tail in the last', () => {
      const ring: ScrollbackRing = [
        { data: 'old', geometry: A },
        { data: 'v1-ish' },
        { data: 'new', geometry: B },
      ];
      const { data, runs, tail } = coldReplay(ring);
      expect(tail).toEqual({ data: `${REPLAY_MODE_NEUTRALIZER}\r\n`, geometry: B });
      expect(data).toBe(`oldv1-ishnew${tail?.data}`);
      expect(runs).toEqual([
        { length: 3, geometry: A },
        { length: 6 },
        { length: 3 + (tail?.data.length ?? 0), geometry: B },
      ]);
    });
  });

  describe('attachReplay', () => {
    it('is the ring as it is, run by run: no neutralizer, newline or marker', () => {
      const ring: ScrollbackRing = [
        { data: 'old', geometry: A },
        { data: '', geometry: B },
        { data: 'v1-ish' },
        { data: 'live', geometry: B },
      ];
      const { data, runs } = attachReplay(ring);
      expect(data).toBe('oldv1-ishlive');
      expect(runs).toEqual([{ length: 3, geometry: A }, { length: 6 }, { length: 4, geometry: B }]);
      expect(data).not.toContain(REPLAY_MODE_NEUTRALIZER);
      expect(data).not.toContain('relaunched');
    });

    it('is empty for an empty ring', () => {
      expect(attachReplay([])).toEqual({ data: '', runs: [] });
    });
  });

  it('round-trips serialize -> restore, segment geometry included', () => {
    const p: PersistedScrollback = {
      version: 2,
      sessionId: 's1',
      segments: [
        { data: 'line1\r\n', geometry: { cols: 144, rows: 73 } },
        { data: '\x1b[2mdim\x1b[0m\r\n' },
        { data: 'line3\r\n', geometry: B },
      ],
    };
    expect(restoreScrollback(serializeScrollback(p))).toEqual(p);
  });

  it('writes a segment on disk as {cols, rows, data}', () => {
    const blob = serializeScrollback({
      version: 2,
      sessionId: 's1',
      segments: [{ data: 'x', geometry: B }, { data: 'y' }],
    });
    expect(JSON.parse(blob)).toEqual({
      version: 2,
      sessionId: 's1',
      segments: [{ cols: 90, rows: 20, data: 'x' }, { data: 'y' }],
    });
  });

  it('loads a v1 file (written before geometry was recorded) as one segment with no geometry', () => {
    const v1 = JSON.stringify({ version: 1, sessionId: 's1', data: 'old\r\n' });
    expect(restoreScrollback(v1)).toEqual({
      version: 2,
      sessionId: 's1',
      segments: [{ data: 'old\r\n' }],
    });
  });

  it.each([
    ['missing', {}],
    ['zero cols', { cols: 0, rows: 24 }],
    ['negative rows', { cols: 80, rows: -1 }],
    ['fractional', { cols: 80.5, rows: 24 }],
    ['non-numeric', { cols: '80', rows: 24 }],
    ['absurd', { cols: 100000, rows: 24 }],
  ])('keeps a segment but drops %s geometry', (_label, geometry) => {
    const blob = JSON.stringify({
      version: 2,
      sessionId: 's',
      segments: [{ ...geometry, data: 'x' }],
    });
    expect(restoreScrollback(blob)).toEqual({
      version: 2,
      sessionId: 's',
      segments: [{ data: 'x' }],
    });
  });

  it('returns null on missing or garbage input', () => {
    expect(restoreScrollback(undefined)).toBeNull();
    expect(restoreScrollback('not json')).toBeNull();
    expect(restoreScrollback('{"version":3,"sessionId":"s","segments":[]}')).toBeNull();
    expect(restoreScrollback('{"version":2,"sessionId":"s"}')).toBeNull();
    expect(restoreScrollback('{"version":2,"sessionId":"s","segments":[{"cols":80}]}')).toBeNull();
    expect(restoreScrollback('{"version":2,"sessionId":"s","segments":[null]}')).toBeNull();
    expect(restoreScrollback('{"version":2,"segments":[]}')).toBeNull();
    expect(restoreScrollback('{"version":1,"sessionId":"s"}')).toBeNull();
    expect(restoreScrollback('[]')).toBeNull();
  });

  describe('scrollbackReplayPadding', () => {
    it('emits one screen of newlines on win32 to push history into scrollback', () => {
      expect(scrollbackReplayPadding('win32', 24)).toBe('\r\n'.repeat(24));
    });

    it('is empty off-Windows (those PTYs do not clear on spawn)', () => {
      expect(scrollbackReplayPadding('linux', 24)).toBe('');
      expect(scrollbackReplayPadding('darwin', 24)).toBe('');
    });

    it('is empty when the row count is unknown or non-positive', () => {
      expect(scrollbackReplayPadding('win32', 0)).toBe('');
      expect(scrollbackReplayPadding('win32', -5)).toBe('');
    });
  });
});
