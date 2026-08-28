import type * as monaco from 'monaco-editor';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type ChangeMarker,
  peekAfterLine,
  peekHeightInLines,
  reducePeek,
} from './change-decorations';

/**
 * The change peek's Monaco half (spec 2026-08-27-review-supercharge §2 Lane E).
 *
 * The codebase's first view zone, so the rule is set here: ONE zone at a time, created by the
 * effect that also destroys it, with the React contents living in a portal into the zone's own
 * domNode. Every way the peek can end — close, another marker, a model swap, the editor going
 * away, a recompute that shortened the marker list — reduces to the same effect re-running, so
 * there is no second teardown path to forget.
 */

export interface PeekZoneApi {
  /** Index into `markers`, or null when nothing is open. */
  index: number | null;
  open(index: number): void;
  close(): void;
  next(): void;
  prev(): void;
  /** Render this from the consuming component; null while closed. */
  portal: ReactNode;
}

export function usePeekZone({
  editor,
  markers,
  render,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  markers: ChangeMarker[];
  render: (index: number, total: number, close: () => void) => ReactNode;
}): PeekZoneApi {
  const [index, setIndex] = useState<number | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const total = markers.length;

  const close = useCallback(() => {
    setIndex((i) => (i === null ? null : reducePeek(i, { type: 'close' }, total)));
    // Esc must land the caret back where the reader was, not leave focus on a removed node.
    editorRef.current?.focus();
  }, [total]);

  const open = useCallback(
    (next: number) => setIndex((i) => reducePeek(i, { type: 'open', index: next }, total)),
    [total],
  );
  const next = useCallback(() => setIndex((i) => reducePeek(i, { type: 'next' }, total)), [total]);
  const prev = useCallback(() => setIndex((i) => reducePeek(i, { type: 'prev' }, total)), [total]);

  // A recompute can shorten or empty the marker list under an open peek.
  useEffect(() => {
    setIndex((i) => reducePeek(i, { type: 'sync' }, total));
  }, [total]);

  const marker = index === null ? undefined : markers[index];

  // The zone's GEOMETRY, not the marker object. `markers` is rebuilt on every recompute — a
  // 300 ms debounce the whole editor shares — so depending on the marker's identity tore the
  // zone down and built it again several times a second: the peek flickered and, because the
  // portal was unmounted with it, focus fell out of the dialog and Esc stopped closing it.
  const afterLine = marker ? peekAfterLine(marker) : 0;
  const zoneHeight = marker ? peekHeightInLines(marker.removedText.length) : 0;
  const revealLine = marker ? Math.max(1, marker.startLine) : 0;
  const zoneOpen = marker !== undefined;

  // Opening a different marker still tears the old zone down before building the new one —
  // never two at once.
  useEffect(() => {
    if (!editor || !zoneOpen) {
      setHost(null);
      return;
    }
    const node = document.createElement('div');
    node.className = 'peekzone';
    let zoneId = '';
    editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone({
        afterLineNumber: afterLine,
        heightInLines: zoneHeight,
        domNode: node,
      });
    });
    // Lay the zone out NOW. addZone only schedules it, so without this the portal mounts into
    // a node Monaco has not attached yet — and focusing a detached node is a silent no-op,
    // which left the dialog unfocusable and Esc dead.
    editor.render(true);
    setHost(node);
    editor.revealLineInCenterIfOutsideViewport(revealLine);
    return () => {
      editor.changeViewZones((accessor) => {
        if (zoneId) accessor.removeZone(zoneId);
      });
      setHost(null);
    };
  }, [editor, zoneOpen, afterLine, zoneHeight, revealLine]);

  // A model swap replaces every line number the open peek was anchored to.
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onDidChangeModel(() => setIndex(null));
    return () => sub.dispose();
  }, [editor]);

  // Esc has to close the peek from the EDITOR too, not just from inside the dialog. Opening it
  // is a click in the gutter, and Monaco focuses the editor as part of handling that mousedown —
  // so the key lands on Monaco's textarea, which is no descendant of the portal and never
  // reaches the dialog's own onKeyDown. Monaco's built-in peek widgets register the same way.
  useEffect(() => {
    if (!editor || !zoneOpen) return;
    const sub = editor.onKeyDown((e) => {
      if (e.browserEvent.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    return () => sub.dispose();
  }, [editor, zoneOpen, close]);

  const portal = host && index !== null ? createPortal(render(index, total, close), host) : null;

  return useMemo(
    () => ({ index, open, close, next, prev, portal }),
    [index, open, close, next, prev, portal],
  );
}
