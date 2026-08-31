import * as monaco from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeadBlobReason, HostToWebview } from '../src/protocol';
import { isUnderRoot } from '../src/repo-rel';
import { computeFileReview } from '../src/review-hunks';
import { contentHash } from '../src/review-marks';
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
  getLatestHeadBlob,
  type HeadBlob,
  invalidateHeadBlob,
  putHeadBlob,
} from './head-blob-cache';
import { onFileSaved } from './save-registry';
import { makeDebouncedFlush } from './use-debounced-flush';

export type ChangeMarkersState = 'none' | 'loading' | 'live' | 'degraded' | 'stale';

export interface ChangeMarkersApi {
  state: ChangeMarkersState;
  markers: ChangeMarker[];
  /** Live-region text; '' when there is nothing to announce. */
  announcement: string;
  goToChange(direction: 'next' | 'prev'): void;
  /** The file has no HEAD blob — the peek says so instead of offering a diff. */
  untracked: boolean;
  /**
   * Fingerprint of the exact two texts these markers were computed from, for a hunk op's
   * staleness check. Null while there is nothing to act on. The work side is the MODEL, so an
   * unsaved buffer fingerprints differently from the file on disk and the host refuses — which
   * is the right answer: the range would describe lines git cannot see.
   */
  hashes: { head: string; work: string } | null;
}

/** Long enough to skip a keystroke burst, short enough to feel live (spec §2 Lane A). */
const RECOMPUTE_DEBOUNCE_MS = 300;

/** Shown as a banner AND spoken on a navigation attempt, so the wording lives in one place. */
export const DEGRADED_HINT = 'Change markers off — file changed too much to line-match.';

/**
 * Why the map is empty, spoken on a navigation attempt. Before this, every one of these took the
 * same silent `clear()` and was indistinguishable from "this file has no changes" — the most
 * common of them, a folder that is not a git repo, most of all. Deliberately spoken rather than
 * bannered: a persistent banner for a non-repo is noise (spec §4 decision 6).
 */
/** `untracked` is deliberately absent: it is the one reason that does NOT land here, because an
 *  untracked file still gets gutter bars and a live state of its own. */
const UNAVAILABLE: Record<Exclude<HeadBlobReason, 'untracked'>, string> = {
  binary: 'Change markers unavailable — binary file',
  oversize: 'Change markers unavailable — the file in HEAD is too large to compare',
  notRepo: 'Change markers unavailable — this folder is not a git repository',
  error: 'Change markers unavailable — git could not read this file at HEAD',
};

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
    // Inline, not Gutter: the gutter rail is a 2 px sliver — a third of the ruler mark it is
    // meant to echo (spec §4 R3.2, blockers Q2).
    minimapPosition: monaco.editor.MinimapPosition.Inline,
  };
}

export function useChangeMarkers({
  editor,
  path,
  enabled,
  themeId,
  ignoreWhitespace,
}: {
  /** The live editor, or null before one exists. STATE rather than a ref: a NEW instance has to
   *  re-run the effects below, and a ref mutation doesn't re-render. */
  editor: monaco.editor.IStandaloneCodeEditor | null;
  path: string;
  enabled: boolean;
  /** Theme id — re-resolves the marker colours and re-sets the collection. */
  themeId: string;
  /** The user's `reviewIgnoreWhitespace`: one setting, two surfaces, so a pure re-indent shows
   *  nothing here exactly as it shows nothing in Review (spec §4 decision 5). */
  ignoreWhitespace: boolean;
}): ChangeMarkersApi {
  const [state, setState] = useState<ChangeMarkersState>('none');
  const [markers, setMarkers] = useState<ChangeMarker[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [untracked, setUntracked] = useState(false);
  const [hashes, setHashes] = useState<{ head: string; work: string } | null>(null);

  const collectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const headRef = useRef<HeadBlob | null>(null);
  const requestRef = useRef(0);
  const markersRef = useRef<ChangeMarker[]>([]);
  const stateRef = useRef<ChangeMarkersState>('none');
  stateRef.current = state;
  const announceFrame = useRef(0);
  /** Whether the current markers may paint the ruler/minimap — false for an untracked file. */
  const mapRef = useRef(true);
  /** The reason the map is empty, for `goToChange` to speak. Never `untracked` — see UNAVAILABLE. */
  const reasonRef = useRef<Exclude<HeadBlobReason, 'untracked'> | null>(null);

  // A live region is spoken only when its text CHANGES, so "Change 1 of 1" twice in a row has
  // to clear and re-set a frame later to be heard the second time.
  const announce = useCallback((text: string) => {
    cancelAnimationFrame(announceFrame.current);
    setAnnouncement('');
    announceFrame.current = requestAnimationFrame(() => setAnnouncement(text));
  }, []);
  useEffect(() => () => cancelAnimationFrame(announceFrame.current), []);

  const apply = useCallback((next: ChangeMarker[], map = true) => {
    markersRef.current = next;
    mapRef.current = map;
    setMarkers(next);
    collectionRef.current?.set(hunksToDecorations(next, readStyle(), { map }));
  }, []);

  const clear = useCallback(() => {
    markersRef.current = [];
    setMarkers([]);
    collectionRef.current?.clear();
  }, []);

  const recompute = useCallback(() => {
    const model = editor?.getModel();
    if (!model || !enabled) {
      clear();
      setState('none');
      setUntracked(false);
      setHashes(null);
      reasonRef.current = null;
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
      setUntracked(false);
      setHashes(null);
      reasonRef.current = head.reason;
      return;
    }
    reasonRef.current = null;
    if (head.reason === 'untracked') {
      const count = model.getLineCount();
      // Gutter bars only: every line IS new, but with no baseline there is nothing for a ruler
      // or minimap mark to locate against, and one whole-file marker paints them solid (§4 R3.3).
      apply(
        [
          {
            kind: 'added',
            startLine: 1,
            endLine: count,
            addedLines: count,
            removedLines: 0,
            oldRange: [1, 0],
            removedText: [],
          },
        ],
        false,
      );
      setState('live');
      setUntracked(true);
      // An untracked file has no baseline; Stage maps to the whole-file stageFile op, which
      // takes no range and so needs no fingerprint.
      setHashes(null);
      return;
    }
    setUntracked(false);
    const review = computeFileReview(
      head.text ?? '',
      model.getValue(),
      3,
      MAX_DECORATION_LCS_CELLS,
      {
        ignoreWhitespace,
      },
    );
    if (review.approx) {
      clear();
      setState('degraded');
      setHashes(null);
      return;
    }
    apply(hunksToMarkers(review.hunks, model.getLineCount()));
    setState('live');
    // LF explicitly: the HEAD blob arrives LF-normalised (src/head-blob.ts) and the host
    // hashes the same way, so a CRLF model must not fingerprint differently.
    setHashes({
      head: contentHash(head.text ?? ''),
      work: contentHash(model.getValue(monaco.editor.EndOfLinePreference.LF)),
    });
  }, [apply, clear, editor, enabled, ignoreWhitespace]);

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
  useEffect(() => {
    if (!editor) return;
    const collection = editor.createDecorationsCollection([]);
    collectionRef.current = collection;
    return () => {
      collection.clear();
      collectionRef.current = null;
    };
  }, [editor]);

  // Mount + live recompute: the model's own edits, debounced.
  useEffect(() => {
    const model = editor?.getModel();
    if (!model) return;
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
  }, [editor, enabled, fetchHead]);

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
      headRef.current = blob;
      recomputeRef.current();
    });
  }, [path]);

  // HEAD moved, or the file changed on disk. `.git/HEAD` and `.git/refs/**` are deliberately
  // NOT filtered out of the watch (src/watch-filter.ts), so a commit or checkout arrives here.
  useEffect(() => {
    if (!enabled) return;
    const debounced = makeDebouncedFlush(() => {
      // The old collection stands until the new blob lands — no all-added flash (§2 Lane A).
      if (markersRef.current.length > 0) setState('stale');
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
  // re-resolve them and re-set the collection (spec §11). The rAF is what every other CSS-var
  // reader in the renderer does: applyToDom is a PARENT effect, so <html> still carries the OLD
  // data-theme while this one runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeId is the trigger — the colours are read off <html>'s CSS vars, not from the value.
  useEffect(() => {
    if (markersRef.current.length === 0) return;
    const id = requestAnimationFrame(() => {
      collectionRef.current?.set(
        hunksToDecorations(markersRef.current, readStyle(), { map: mapRef.current }),
      );
    });
    return () => cancelAnimationFrame(id);
  }, [themeId]);

  // The whitespace setting changes what counts as a change, so it re-diffs the buffer we already
  // hold — no HEAD round trip. The mount effect owns the first pass; this owns every later flip.
  const lastIgnoreWhitespace = useRef(ignoreWhitespace);
  useEffect(() => {
    if (lastIgnoreWhitespace.current === ignoreWhitespace) return;
    lastIgnoreWhitespace.current = ignoreWhitespace;
    recomputeRef.current();
  }, [ignoreWhitespace]);

  const goToChange = useCallback(
    (direction: 'next' | 'prev') => {
      if (!editor) return;
      if (!enabled) {
        announce('Change markers are off');
        return;
      }
      if (stateRef.current === 'degraded') {
        announce(DEGRADED_HINT);
        return;
      }
      if (reasonRef.current) {
        announce(UNAVAILABLE[reasonRef.current]);
        return;
      }
      const current = editor.getPosition()?.lineNumber ?? 1;
      const hit = navigateMarkers(markersRef.current, current, direction);
      if (!hit) {
        announce('No changes');
        return;
      }
      editor.setPosition({ lineNumber: hit.line, column: 1 });
      editor.revealLineInCenter(hit.line);
      editor.focus();
      announce(`Change ${hit.index} of ${hit.total}`);
    },
    [announce, editor, enabled],
  );

  return useMemo(
    () => ({ state, markers, announcement, goToChange, untracked, hashes }),
    [state, markers, announcement, goToChange, untracked, hashes],
  );
}
