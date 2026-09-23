import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { BackgroundOutcome } from './docs';
import { backgroundOpenAnnouncement } from './middle-click';

const TAB_FLASH_MS = 600;

interface BackgroundOpenReport {
  id: string;
  title: string;
  outcome: BackgroundOutcome;
  sessionName: string | null;
}

interface BackgroundOpenFeedback {
  flashTabId: string | null;
  statusRef: RefObject<HTMLDivElement | null>;
  report: (r: BackgroundOpenReport) => void;
}

/** The tab cue and the polite announcement for a background open (spec
 *  2026-09-22-middle-click-new-tab §3 "Cue + announce"). */
export function useBackgroundOpenFeedback(): BackgroundOpenFeedback {
  const [flashTabId, setFlashTabId] = useState<string | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);

  // Both the cue and the announcement are cleared now and set a frame later: a CSS animation
  // restarts only if a frame is styled without its class, and a screen reader re-reads a live
  // region only if its text changed — so a repeat on the same tab replays both. Call it only from
  // an event handler or a subscription callback, never during render or a React effect: it
  // flushSyncs.
  const report = useCallback((r: BackgroundOpenReport) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    flushSync(() => setFlashTabId(null));
    const el = statusRef.current;
    if (el) el.textContent = '';
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setFlashTabId(r.id);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setFlashTabId(null);
      }, TAB_FLASH_MS);
      if (el) el.textContent = backgroundOpenAnnouncement(r.outcome, r.title, r.sessionName);
    });
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return { flashTabId, statusRef, report };
}
