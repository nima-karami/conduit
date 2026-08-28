import { describe, expect, it } from 'vitest';
import {
  anchorAt,
  anchorFor,
  applyNotePatch,
  canAddNote,
  emptyNotesData,
  MAX_NOTE_BODY,
  MAX_OPEN_NOTES_PER_REPO,
  MAX_STORED_NOTES_PER_REPO,
  notesFingerprint,
  openNotes,
  pendingNotes,
  type ReviewNote,
  reanchor,
  restoreNotes,
  serializeNotes,
  snippetOf,
} from '../../src/review-notes';

const NOW = '2026-08-28T10:00:00.000Z';

function note(over: Partial<ReviewNote> = {}): ReviewNote {
  const text = over.snippet ?? 'const x = 1;';
  return {
    id: 'note-1',
    path: 'src/foo.ts',
    side: 'new',
    line: 2,
    anchor: anchorFor(text, 'before', 'after'),
    snippet: text,
    body: 'why this?',
    createdAt: NOW,
    ...over,
  };
}

describe('anchorFor / anchorAt', () => {
  it('hashes the line together with one context line each side', () => {
    expect(anchorFor('b', 'a', 'c')).not.toBe(anchorFor('b', 'a', 'd'));
    expect(anchorFor('b', 'a', 'c')).not.toBe(anchorFor('b', 'x', 'c'));
    expect(anchorFor('b', 'a', 'c')).toBe(anchorFor('b', 'a', 'c'));
  });

  it('treats a missing neighbour as distinct from an empty one, so file edges are stable', () => {
    expect(anchorFor('only', null, null)).toBe(anchorFor('only', null, null));
    expect(anchorFor('only', null, null)).not.toBe(anchorFor('only', '', ''));
  });

  it('anchorAt reads 1-based lines and returns null outside the file', () => {
    const lines = ['a', 'b', 'c'];
    expect(anchorAt(lines, 2)).toBe(anchorFor('b', 'a', 'c'));
    expect(anchorAt(lines, 1)).toBe(anchorFor('a', null, 'b'));
    expect(anchorAt(lines, 3)).toBe(anchorFor('c', 'b', null));
    expect(anchorAt(lines, 0)).toBeNull();
    expect(anchorAt(lines, 4)).toBeNull();
  });
});

describe('snippetOf', () => {
  it('trims and caps at 60 characters with an ellipsis', () => {
    expect(snippetOf('   const x = 1;   ')).toBe('const x = 1;');
    expect(snippetOf('x'.repeat(80))).toBe(`${'x'.repeat(60)}…`);
    expect(snippetOf('')).toBe('');
  });
});

describe('applyNotePatch', () => {
  it('adds a note', () => {
    const next = applyNotePatch([], { op: 'add', note: note() });
    expect(next).toHaveLength(1);
    expect(next[0].body).toBe('why this?');
  });

  it('refuses an add at the OPEN-note cap, and allows it again after a resolve', () => {
    const full = Array.from({ length: MAX_OPEN_NOTES_PER_REPO }, (_, i) => note({ id: `n${i}` }));
    expect(canAddNote(full)).toBe(false);
    expect(applyNotePatch(full, { op: 'add', note: note({ id: 'extra' }) })).toHaveLength(
      MAX_OPEN_NOTES_PER_REPO,
    );

    const oneResolved = applyNotePatch(full, { op: 'resolve', id: 'n0', resolved: true, at: NOW });
    expect(canAddNote(oneResolved)).toBe(true);
    expect(applyNotePatch(oneResolved, { op: 'add', note: note({ id: 'extra' }) })).toHaveLength(
      MAX_OPEN_NOTES_PER_REPO + 1,
    );
  });

  it('ignores an add whose body is blank or over the 4 KB bound', () => {
    expect(applyNotePatch([], { op: 'add', note: note({ body: '   ' }) })).toHaveLength(0);
    expect(
      applyNotePatch([], { op: 'add', note: note({ body: 'x'.repeat(MAX_NOTE_BODY + 1) }) }),
    ).toHaveLength(0);
  });

  it('ignores an add whose id is already present, so a replayed patch is idempotent', () => {
    const once = applyNotePatch([], { op: 'add', note: note() });
    expect(applyNotePatch(once, { op: 'add', note: note() })).toHaveLength(1);
  });

  it('edits a body and ignores an edit of an unknown id', () => {
    const list = [note()];
    expect(applyNotePatch(list, { op: 'edit', id: 'note-1', body: 'better' })[0].body).toBe(
      'better',
    );
    expect(applyNotePatch(list, { op: 'edit', id: 'nope', body: 'x' })).toEqual(list);
  });

  it('resolves and unresolves', () => {
    const resolved = applyNotePatch([note()], {
      op: 'resolve',
      id: 'note-1',
      resolved: true,
      at: NOW,
    });
    expect(resolved[0].resolvedAt).toBe(NOW);
    const reopened = applyNotePatch(resolved, {
      op: 'resolve',
      id: 'note-1',
      resolved: false,
      at: NOW,
    });
    expect(reopened[0].resolvedAt).toBeUndefined();
  });

  it('deletes', () => {
    expect(applyNotePatch([note()], { op: 'delete', id: 'note-1' })).toHaveLength(0);
  });

  it('stamps sentAt on exactly the listed ids', () => {
    const list = [note(), note({ id: 'note-2' })];
    const sent = applyNotePatch(list, { op: 'sent', ids: ['note-2'], at: NOW });
    expect(sent[0].sentAt).toBeUndefined();
    expect(sent[1].sentAt).toBe(NOW);
  });

  it('never mutates the input array', () => {
    const list = [note()];
    applyNotePatch(list, { op: 'delete', id: 'note-1' });
    expect(list).toHaveLength(1);
  });
});

describe('openNotes / pendingNotes', () => {
  it('open = unresolved; pending = unresolved AND unsent', () => {
    const list = [
      note({ id: 'a' }),
      note({ id: 'b', sentAt: NOW }),
      note({ id: 'c', resolvedAt: NOW }),
    ];
    expect(openNotes(list).map((n) => n.id)).toEqual(['a', 'b']);
    expect(pendingNotes(list).map((n) => n.id)).toEqual(['a']);
  });
});

describe('reanchor', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];

  it('keeps a note on its exact line when the text is unchanged', () => {
    const n = note({ line: 3, anchor: anchorFor('c', 'b', 'd'), snippet: 'c' });
    expect(reanchor([n], lines)).toEqual([{ note: n, line: 3 }]);
  });

  it('follows a line that moved within the radius', () => {
    const n = note({ line: 1, anchor: anchorFor('c', 'b', 'd'), snippet: 'c' });
    expect(reanchor([n], lines)[0].line).toBe(3);
  });

  it('detaches a note whose anchored line is gone', () => {
    const n = note({ line: 3, anchor: anchorFor('gone', 'x', 'y'), snippet: 'gone' });
    expect(reanchor([n], lines)[0].line).toBeNull();
  });

  it('detaches a note whose line moved further than the radius', () => {
    const far = [...Array.from({ length: 200 }, (_, i) => `f${i}`), 'b', 'c', 'd'];
    const n = note({ line: 1, anchor: anchorFor('c', 'b', 'd'), snippet: 'c' });
    expect(reanchor([n], far)[0].line).toBeNull();
  });

  it('picks the NEAREST of two candidate lines, and the lower one on a tie', () => {
    // `x` with context `w`/`y` appears at line 2 and at line 8 — equidistant from 5.
    const dup = ['w', 'x', 'y', 'p', 'q', 'r', 'w', 'x', 'y'];
    const anchor = anchorFor('x', 'w', 'y');
    expect(reanchor([note({ line: 5, anchor, snippet: 'x' })], dup)[0].line).toBe(2);
    expect(reanchor([note({ line: 7, anchor, snippet: 'x' })], dup)[0].line).toBe(8);
  });

  it('detaches every note when the reader splits CRLF text without normalising it', () => {
    // Why every reader has to normalise: an anchor is hashed over LINE TEXT, and `diff.work`
    // reaches the renderer LF-normalised (src/file-service.ts). Splitting a CRLF buffer on '\n'
    // leaves a trailing '\r' on every line, so nothing matches. The editor mirror reads its model
    // with EndOfLinePreference.LF for exactly this reason (webview/use-note-markers.ts).
    const lf = ['a', 'b', 'c'];
    const crlfSplit = 'a\r\nb\r\nc'.split('\n');
    const n = note({ line: 2, anchor: anchorFor('b', 'a', 'c'), snippet: 'b' });
    expect(reanchor([n], lf)[0].line).toBe(2);
    expect(reanchor([n], crlfSplit)[0].line).toBeNull();
  });

  it('detaches everything in an empty file', () => {
    expect(reanchor([note()], [])[0].line).toBeNull();
  });
});

describe('restoreNotes / serializeNotes', () => {
  it('round-trips', () => {
    const data = { version: 1 as const, notes: [note()] };
    expect(restoreNotes(serializeNotes(data))).toEqual(data);
  });

  it('is empty for absent, unparseable, foreign-version and non-object input', () => {
    expect(restoreNotes(undefined)).toEqual(emptyNotesData());
    expect(restoreNotes('{oops')).toEqual(emptyNotesData());
    expect(restoreNotes('[]')).toEqual(emptyNotesData());
    expect(restoreNotes(JSON.stringify({ version: 2, notes: [note()] }))).toEqual(emptyNotesData());
  });

  it('drops malformed entries rather than the whole file', () => {
    const blob = JSON.stringify({ version: 1, notes: [note(), { id: 'bad' }, null] });
    expect(restoreNotes(blob).notes).toHaveLength(1);
  });

  it('keeps everything it reads: the ceiling is a WRITE bound, not a read filter', () => {
    // Trimming on read would silently drop notes an agent had written into the file, and the
    // next save would persist that truncation as if the user had deleted them.
    const many = [
      ...Array.from({ length: MAX_STORED_NOTES_PER_REPO }, (_, i) => note({ id: `n${i}` })),
      note({ id: 'extra' }),
    ];
    const kept = restoreNotes(JSON.stringify({ version: 1, notes: many })).notes;
    expect(kept).toHaveLength(MAX_STORED_NOTES_PER_REPO + 1);
    expect(kept.some((n) => n.id === 'extra')).toBe(true);
  });

  it('trims on WRITE, keeping unresolved notes first so live work is never dropped', () => {
    const many = [
      ...Array.from({ length: MAX_STORED_NOTES_PER_REPO }, (_, i) =>
        note({ id: `r${i}`, resolvedAt: NOW, createdAt: '2020-01-01T00:00:00.000Z' }),
      ),
      note({ id: 'live' }),
    ];
    const written = JSON.parse(serializeNotes({ version: 1, notes: many })) as {
      notes: ReviewNote[];
    };
    expect(written.notes).toHaveLength(MAX_STORED_NOTES_PER_REPO);
    expect(written.notes.some((n) => n.id === 'live')).toBe(true);
  });
});

describe('notesFingerprint', () => {
  it('is stable for equal content and differs on any change', () => {
    const a = { version: 1 as const, notes: [note()] };
    const b = { version: 1 as const, notes: [note()] };
    expect(notesFingerprint(a)).toBe(notesFingerprint(b));
    expect(notesFingerprint(a)).not.toBe(
      notesFingerprint({ version: 1, notes: [note({ body: 'other' })] }),
    );
  });
});
