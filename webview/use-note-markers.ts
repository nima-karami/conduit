import * as monaco from 'monaco-editor';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { foldRelPath, repoRelPath } from '../src/repo-rel';
import { type ReviewNote, reanchor } from '../src/review-notes';
import { type NoteMarker, notesToDecorations, notesToMarkers } from './note-decorations';
import { getNotesSnapshot, subscribeNotes } from './review-notes-store';
import { makeDebouncedFlush } from './use-debounced-flush';

/**
 * The editor's read-only mirror of Review's notes (spec 2026-08-27-review-supercharge §2 Lane F).
 * Reuses Lane A's decoration lifecycle — one collection per editor, `.set()` wholesale, cleared
 * with the editor — and adds NOTHING to the model: no view zone (that is Lane E's), no editing.
 */
/** Matches Lane A: one re-anchor per burst of typing, not one per keystroke. */
const RECOMPUTE_DEBOUNCE_MS = 300;

export function useNoteMarkers({
  editor,
  path,
  onOpenNote,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  /** Absolute path of the open file. */
  path: string;
  onOpenNote: (note: ReviewNote, line: number) => void;
}): void {
  const snapshot = useSyncExternalStore(subscribeNotes, getNotesSnapshot, getNotesSnapshot);
  const collectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const markersRef = useRef<NoteMarker[]>([]);
  const onOpenRef = useRef(onOpenNote);
  onOpenRef.current = onOpenNote;

  // Which repo this file belongs to: the longest loaded root that contains it. No new IPC — the
  // store already holds every root Review or app.tsx has asked for.
  const notesForPath = useCallback((): ReviewNote[] => {
    let best = '';
    let bestRel: string | null = null;
    for (const root of snapshot.byRoot.keys()) {
      if (root.length <= best.length) continue;
      const rel = repoRelPath(root, path);
      if (rel === null) continue;
      best = root;
      bestRel = rel;
    }
    if (bestRel === null) return [];
    const want = foldRelPath(best, bestRel);
    return (snapshot.byRoot.get(best) ?? []).filter((n) => foldRelPath(best, n.path) === want);
  }, [snapshot, path]);

  useEffect(() => {
    if (!editor) return;
    const collection = editor.createDecorationsCollection([]);
    collectionRef.current = collection;
    return () => {
      collection.clear();
      collectionRef.current = null;
      editor.updateOptions({ glyphMargin: false });
    };
  }, [editor]);

  const recompute = useCallback(() => {
    const model = editor?.getModel();
    if (!editor || !model || !collectionRef.current) return;
    // LF explicitly. A note's anchor was hashed against `diff.work`, which the host
    // LF-normalises (src/file-service.ts `toLf`); a CRLF model read with the default EOL would
    // hash every line with a trailing \r and detach every note on the file. Lane A takes the
    // same care for the same reason (use-change-markers.ts).
    const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
    const markers = notesToMarkers(reanchor(notesForPath(), text.split('\n')));
    markersRef.current = markers;
    collectionRef.current.set(notesToDecorations(markers));
    // The margin appears with the first note on a file and goes away with the last, rather than
    // reserving an empty column on every file in the app (Lane F plan, assumption 14).
    editor.updateOptions({ glyphMargin: markers.length > 0 });
  }, [editor, notesForPath]);

  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  useEffect(() => {
    recompute();
  }, [recompute]);

  // The model is editable, and a note anchors to LINE TEXT — so typing above a glyph moves the
  // line it belongs on and typing on it can detach it. Debounced, as Lane A does, so a burst of
  // keystrokes re-anchors once (use-change-markers.ts).
  useEffect(() => {
    const model = editor?.getModel();
    if (!model) return;
    const debounced = makeDebouncedFlush(() => recomputeRef.current(), RECOMPUTE_DEBOUNCE_MS);
    const sub = model.onDidChangeContent(() => debounced.schedule());
    return () => {
      debounced.cancel();
      sub.dispose();
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    // GUTTER_GLYPH_MARGIN, not GUTTER_LINE_DECORATIONS — that strip belongs to the change peek.
    const sub = editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (line === undefined) return;
      const marker = markersRef.current.find((m) => m.line === line);
      if (!marker) return;
      onOpenRef.current(marker.notes[0], line);
    });
    return () => sub.dispose();
  }, [editor]);
}
