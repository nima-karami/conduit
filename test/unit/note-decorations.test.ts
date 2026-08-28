import { describe, expect, it } from 'vitest';
import { type AnchoredNote, anchorFor, type ReviewNote } from '../../src/review-notes';
import { noteHoverText, notesToDecorations, notesToMarkers } from '../../webview/note-decorations';

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: 'n',
  path: 'src/foo.ts',
  side: 'new',
  line: 10,
  anchor: anchorFor('a', null, null),
  snippet: 'a',
  body: 'why this?',
  createdAt: '2026-08-28T10:00:00.000Z',
  ...over,
});
const at = (n: ReviewNote, line: number | null): AnchoredNote => ({ note: n, line });

describe('notesToMarkers', () => {
  it('groups notes by line, ascending', () => {
    const markers = notesToMarkers([
      at(note({ id: 'b', line: 20 }), 20),
      at(note({ id: 'a', line: 10 }), 10),
      at(note({ id: 'a2', line: 10 }), 10),
    ]);
    expect(markers.map((m) => [m.line, m.notes.length])).toEqual([
      [10, 2],
      [20, 1],
    ]);
  });

  it('drops detached and resolved notes', () => {
    expect(notesToMarkers([at(note({}), null)])).toEqual([]);
    expect(notesToMarkers([at(note({ resolvedAt: 'x' }), 10)])).toEqual([]);
  });

  it('only mirrors NEW-side notes: the editor shows the file as it is now', () => {
    expect(notesToMarkers([at(note({ side: 'old' }), 10)])).toEqual([]);
  });
});

describe('noteHoverText', () => {
  it('is the body for one note, and a numbered list for several', () => {
    expect(noteHoverText([note({ body: 'one' })])).toBe('one');
    expect(noteHoverText([note({ id: 'a', body: 'one' }), note({ id: 'b', body: 'two' })])).toBe(
      '2 notes\n\n1. one\n2. two',
    );
  });
});

describe('notesToDecorations', () => {
  it('emits a glyph-margin decoration per marker with the body as its hover', () => {
    const [dec] = notesToDecorations(notesToMarkers([at(note({}), 10)]));
    expect(dec.range).toEqual({
      startLineNumber: 10,
      startColumn: 1,
      endLineNumber: 10,
      endColumn: 1,
    });
    expect(dec.options.glyphMarginClassName).toBe('ndec');
    expect(dec.options.glyphMarginHoverMessage).toEqual({ value: 'why this?' });
  });
});
