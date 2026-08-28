import type { editor } from 'monaco-editor';
import type { AnchoredNote, ReviewNote } from '../src/review-notes';

/**
 * Review notes → Monaco glyph-margin decorations (spec 2026-08-27-review-supercharge §2 Lane F).
 * Pure; monaco is imported TYPE-ONLY so this stays unit-testable in Node, exactly like Lane A's
 * change-decorations.ts. The mark lives in the GLYPH margin so it never competes with Lane A's
 * change bar for the line-decorations strip — which is also the strip the change peek's gutter
 * click listens on (code-viewer.tsx), so the two cannot fire on one click.
 */

export interface NoteMarker {
  /** 1-based model line. */
  line: number;
  notes: ReviewNote[];
}

/** Unresolved, anchored, new-side notes, grouped per line. The editor shows the file as it is
 *  NOW, so an old-side note has no line there; it stays a Review-only row. */
export function notesToMarkers(anchored: readonly AnchoredNote[]): NoteMarker[] {
  const byLine = new Map<number, ReviewNote[]>();
  for (const { note, line } of anchored) {
    if (line === null || note.side !== 'new' || note.resolvedAt !== undefined) continue;
    const list = byLine.get(line);
    if (list) list.push(note);
    else byLine.set(line, [note]);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, notes]) => ({ line, notes }));
}

export function noteHoverText(notes: readonly ReviewNote[]): string {
  if (notes.length === 1) return notes[0].body;
  return [`${notes.length} notes`, '', ...notes.map((n, i) => `${i + 1}. ${n.body}`)].join('\n');
}

export function notesToDecorations(markers: readonly NoteMarker[]): editor.IModelDeltaDecoration[] {
  return markers.map((m) => ({
    range: { startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: 1 },
    options: {
      glyphMarginClassName: 'ndec',
      glyphMarginHoverMessage: { value: noteHoverText(m.notes) },
    },
  }));
}
