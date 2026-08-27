import * as monaco from 'monaco-editor';
import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebview } from '../src/protocol';
import { isUnderRoot } from '../src/repo-rel';
import { computeFileReview } from '../src/review-hunks';
import { post, subscribe } from './bridge';
import {
  type ChangeDecorationStyle,
  type ChangeMarker,
  hunksToDecorations,
  hunksToMarkers,
  MAX_DECORATION_LCS_CELLS,
  navigateMarkers,
} from './change-decorations';
import { cssVar } from './css-var';
import {
  getHeadBlob,
  getLatestHeadBlob,
  type HeadBlob,
  invalidateHeadBlob,
  putHeadBlob,
} from './head-blob-cache';
import { onFileSaved } from './save-registry';
import { makeDebouncedFlush } from './use-debounced-flush';

export type ChangeMarkersState = 'none' | 'loading' | 'live' | 'degraded';

export interface ChangeMarkersApi {
  state: ChangeMarkersState;
  markers: ChangeMarker[];
  /** Live-region text; '' when there is nothing to announce. */
  announcement: string;
  goToChange(direction: 'next' | 'prev'): void;
}

/** Long enough to skip a keystroke burst, short enough to feel live (spec §2 Lane A). */
const RECOMPUTE_DEBOUNCE_MS = 300;

let nextRequestId = 1;

/** Monaco takes literal colours for the ruler and minimap, so the tokens are resolved here. */
function readStyle(): ChangeDecorationStyle {
  const cs = getComputedStyle(document.documentElement);
  return {
    colors: {
      added: cssVar(cs, '--change-added', '#5fbe86'),
      modified: cssVar(cs, '--change-modified', '#d99a52'),
      deleted: cssVar(cs, '--change-deleted', '#e0645a'),
    },
    rulerLane: monaco.editor.OverviewRulerLane.Left,
    minimapPosition: monaco.editor.MinimapPosition.Gutter,
  };
}

export function useChangeMarkers({
  editorRef,
  editorEpoch,
  path,
  enabled,
  themeId,
}: {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  /** Bumped by CodeViewer every time a new editor instance is created. */
  editorEpoch: number;
  path: string;
  enabled: boolean;
  /** Theme id — re-resolves the marker colours and re-sets the collection. */
  themeId: string;
}): ChangeMarkersApi {
  const [state, setState] = useState<ChangeMarkersState>('none');
  const [markers, setMarkers] = useState<ChangeMarker[]>([]);
  const [announcement, setAnnouncement] = useState('');

  const collectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const headRef = useRef<HeadBlob | null>(null);
  const requestRef = useRef(0);
  const markersRef = useRef<ChangeMarker[]>([]);

  const apply = useCallback((next: ChangeMarker[]) => {
    markersRef.current = next;
    setMarkers(next);
    collectionRef.current?.set(hunksToDecorations(next, readStyle()));
  }, []);

  const clear = useCallback(() => {
    markersRef.current = [];
    setMarkers([]);
    collectionRef.current?.clear();
  }, []);

  const recompute = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model || !enabled) {
      clear();
      setState('none');
      return;
    }
    const head = headRef.current;
    // No blob yet: hold the previous decorations rather than flashing an empty gutter, and hold
    // them across a HEAD move too — spec §2 Lane A's `stale` rule.
    if (!head) {
      setState('loading');
      return;
    }
    if (head.reason && head.reason !== 'untracked') {
      clear();
      setState('none');
      return;
    }
    if (head.reason === 'untracked') {
      const count = model.getLineCount();
      apply([{ kind: 'added', startLine: 1, endLine: count, addedLines: count, removedLines: 0 }]);
      setState('live');
      return;
    }
    const review = computeFileReview(
      head.text ?? '',
      model.getValue(),
      3,
      MAX_DECORATION_LCS_CELLS,
    );
    if (review.approx) {
      clear();
      setState('degraded');
      return;
    }
    apply(hunksToMarkers(review.hunks, model.getLineCount()));
    setState('live');
  }, [apply, clear, editorRef, enabled]);

  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  const fetchHead = useCallback(() => {
    const cached = getLatestHeadBlob(path);
    if (cached) {
      headRef.current = cached;
      recomputeRef.current();
      return;
    }
    const requestId = nextRequestId++;
    requestRef.current = requestId;
    post({ type: 'git:headBlob', path, requestId });
  }, [path]);

  // Own the collection for this editor instance; cleared and dropped with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorEpoch is the rebind trigger — editorRef.current is a NEW editor after a remount, and a ref alone can't re-run this.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const collection = editor.createDecorationsCollection([]);
    collectionRef.current = collection;
    return () => {
      collection.clear();
      collectionRef.current = null;
    };
  }, [editorRef, editorEpoch]);

  // Mount + live recompute: the model's own edits, debounced.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorEpoch is the rebind trigger — see the collection effect above.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const debounced = makeDebouncedFlush(() => recomputeRef.current(), RECOMPUTE_DEBOUNCE_MS);
    const sub = model.onDidChangeContent(() => debounced.schedule());
    headRef.current = null;
    setState(enabled ? 'loading' : 'none');
    if (enabled) fetchHead();
    else recomputeRef.current();
    return () => {
      debounced.cancel();
      sub.dispose();
    };
  }, [editorRef, editorEpoch, enabled, fetchHead]);

  // The host's reply. `requestId` is latest-wins: a slow answer for a superseded model must not
  // overwrite a newer one.
  useEffect(() => {
    return subscribe((msg: HostToWebview) => {
      if (msg.type !== 'git:headBlobResult') return;
      if (msg.path !== path || msg.requestId !== requestRef.current) return;
      const blob: HeadBlob = {
        headSha: msg.headSha,
        text: msg.text,
        ...(msg.reason ? { reason: msg.reason } : {}),
      };
      putHeadBlob(path, blob);
      headRef.current = getHeadBlob(path, msg.headSha) ?? blob;
      recomputeRef.current();
    });
  }, [path]);

  // HEAD moved, or the file changed on disk. `.git/HEAD` and `.git/refs/**` are deliberately
  // NOT filtered out of the watch (src/watch-filter.ts), so a commit or checkout arrives here.
  useEffect(() => {
    if (!enabled) return;
    const debounced = makeDebouncedFlush(() => {
      invalidateHeadBlob(path);
      fetchHead();
    }, RECOMPUTE_DEBOUNCE_MS);
    const unsubscribe = subscribe((msg: HostToWebview) => {
      if (msg.type !== 'fsChanged') return;
      if (!isUnderRoot(msg.root, path)) return;
      debounced.schedule();
    });
    const offSaved = onFileSaved((saved) => {
      if (saved !== path) return;
      invalidateHeadBlob(path);
      fetchHead();
    });
    return () => {
      debounced.cancel();
      unsubscribe();
      offSaved();
    };
  }, [enabled, fetchHead, path]);

  // Monaco can't read a CSS var for the ruler/minimap colour, so a theme switch has to
  // re-resolve them and re-set the collection (spec §11).
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeId is the trigger; the colours are read off <html>'s CSS vars, not from the value.
  useEffect(() => {
    if (markersRef.current.length === 0) return;
    collectionRef.current?.set(hunksToDecorations(markersRef.current, readStyle()));
  }, [themeId]);

  const goToChange = useCallback(
    (direction: 'next' | 'prev') => {
      const editor = editorRef.current;
      if (!editor) return;
      if (!enabled) {
        setAnnouncement('Change markers are off');
        return;
      }
      const current = editor.getPosition()?.lineNumber ?? 1;
      const hit = navigateMarkers(markersRef.current, current, direction);
      if (!hit) {
        setAnnouncement('No changes');
        return;
      }
      editor.setPosition({ lineNumber: hit.line, column: 1 });
      editor.revealLineInCenter(hit.line);
      editor.focus();
      setAnnouncement(`Change ${hit.index} of ${hit.total}`);
    },
    [editorRef, enabled],
  );

  return useMemo(
    () => ({ state, markers, announcement, goToChange }),
    [state, markers, announcement, goToChange],
  );
}
