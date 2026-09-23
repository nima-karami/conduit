import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
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

  const report = useCallback((r: BackgroundOpenReport) => {
    setFlashTabId(r.id);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setFlashTabId(null);
    }, TAB_FLASH_MS);

    const el = statusRef.current;
    if (!el) return;
    // A screen reader doesn't re-read an unchanged live region, so clear it first and set the
    // text a frame later; two "already open" clicks in a row are then both announced.
    el.textContent = '';
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      el.textContent = backgroundOpenAnnouncement(r.outcome, r.title, r.sessionName);
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
