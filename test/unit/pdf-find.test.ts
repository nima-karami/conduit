import { describe, expect, it } from 'vitest';
import { base64ToUint8Array, findMatches, PdfFindController } from '../../webview/pdf-find';

// Three pages of concatenated text (the shape `getTextContent` produces once joined).
const PAGES = [
  'Conduit renders a Conduit PDF', // two "conduit" hits
  'no match on this page here',
  'final Conduit line', // one "conduit" hit
];

describe('findMatches', () => {
  it('returns matches in reading order (page, then position)', () => {
    const m = findMatches(PAGES, 'conduit');
    expect(m.map((x) => [x.page, x.start])).toEqual([
      [0, 0],
      [0, 18],
      [2, 6],
    ]);
  });

  it('is case-insensitive', () => {
    expect(findMatches(['CoNdUiT here'], 'conduit')).toHaveLength(1);
    expect(findMatches(['conduit here'], 'CONDUIT')).toHaveLength(1);
  });

  it('returns no matches for an empty or whitespace query', () => {
    expect(findMatches(PAGES, '')).toEqual([]);
  });

  it('returns no matches when the term is absent', () => {
    expect(findMatches(PAGES, 'zzz')).toEqual([]);
  });

  it('does not return overlapping matches (resumes after each hit)', () => {
    expect(findMatches(['aaaa'], 'aa')).toHaveLength(2);
  });

  it('reports correct start/end offsets', () => {
    const [m] = findMatches(['xxConduit'], 'conduit');
    expect(m).toEqual({ page: 0, start: 2, end: 9 });
  });
});

describe('PdfFindController cycling', () => {
  it('search sets the active match to the first result', () => {
    const c = new PdfFindController();
    c.search(PAGES, 'conduit');
    expect(c.count).toBe(3);
    expect(c.activeOrdinal).toBe(1);
    expect(c.active()).toEqual({ page: 0, start: 0, end: 7 });
  });

  it('next() advances and wraps after the last match', () => {
    const c = new PdfFindController();
    c.search(PAGES, 'conduit');
    expect(c.next()?.start).toBe(18); // 2nd
    expect(c.activeOrdinal).toBe(2);
    expect(c.next()?.page).toBe(2); // 3rd
    expect(c.activeOrdinal).toBe(3);
    expect(c.next()?.start).toBe(0); // wraps to 1st
    expect(c.activeOrdinal).toBe(1);
  });

  it('prev() steps back and wraps before the first match', () => {
    const c = new PdfFindController();
    c.search(PAGES, 'conduit');
    expect(c.prev()?.page).toBe(2); // wraps to last
    expect(c.activeOrdinal).toBe(3);
    expect(c.prev()?.start).toBe(18); // 2nd
    expect(c.activeOrdinal).toBe(2);
  });

  it('zero results leaves no active match and next/prev are no-ops', () => {
    const c = new PdfFindController();
    c.search(PAGES, 'zzz');
    expect(c.count).toBe(0);
    expect(c.activeOrdinal).toBe(0);
    expect(c.active()).toBeNull();
    expect(c.next()).toBeNull();
    expect(c.prev()).toBeNull();
  });

  it('re-searching replaces matches and resets the cursor', () => {
    const c = new PdfFindController();
    c.search(PAGES, 'conduit');
    c.next();
    c.search(PAGES, 'page');
    expect(c.count).toBe(1);
    expect(c.activeOrdinal).toBe(1);
  });
});

describe('base64ToUint8Array', () => {
  it('round-trips a known data URL to the original bytes', () => {
    const original = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]); // %PDF + bytes
    const b64 = Buffer.from(original).toString('base64');
    const dataUrl = `data:application/pdf;base64,${b64}`;
    expect(Array.from(base64ToUint8Array(dataUrl))).toEqual(Array.from(original));
  });

  it('accepts a bare base64 string (no data: prefix)', () => {
    const b64 = Buffer.from([1, 2, 3]).toString('base64');
    expect(Array.from(base64ToUint8Array(b64))).toEqual([1, 2, 3]);
  });
});
