/**
 * Announces through a polite live region so a repeat of the same text is still heard: a region
 * speaks only on a change, so it is cleared now and written a frame later (as the approval card's
 * announcements are).
 */
export function createLiveAnnouncer(region: () => HTMLElement | null): (text: string) => void {
  let frame: number | null = null;
  return (text) => {
    const el = region();
    if (!el) return;
    el.textContent = '';
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      const now = region();
      if (now) now.textContent = text;
    });
  };
}
