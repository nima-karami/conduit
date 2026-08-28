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

  // The zone itself. Keyed on the editor and the marker, so opening a different one tears the old
  // zone down before building the new one — never two at once.
  useEffect(() => {
    if (!editor || !marker) {
      setHost(null);
      return;
    }
    const node = document.createElement('div');
    node.className = 'peekzone';
    let zoneId = '';
    editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone({
        afterLineNumber: peekAfterLine(marker),
        heightInLines: peekHeightInLines(marker.removedText.length),
        domNode: node,
      });
    });
    setHost(node);
    editor.revealLineInCenterIfOutsideViewport(Math.max(1, marker.startLine));
    return () => {
      editor.changeViewZones((accessor) => {
        if (zoneId) accessor.removeZone(zoneId);
      });
      setHost(null);
    };
  }, [editor, marker]);

  // A model swap replaces every line number the open peek was anchored to.
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onDidChangeModel(() => setIndex(null));
    return () => sub.dispose();
  }, [editor]);

  const portal = host && index !== null ? createPortal(render(index, total, close), host) : null;

  return useMemo(
    () => ({ index, open, close, next, prev, portal }),
    [index, open, close, next, prev, portal],
  );
}
