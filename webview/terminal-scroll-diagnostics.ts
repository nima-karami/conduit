/**
 * TEMPORARY diagnostics for the "scroll gets locked after the session was in the background"
 * report. Remove once that bug is understood.
 *
 * What is known: generating output while a session's pane is HIDDEN, then switching back and
 * scrolling up, leaves the terminal unable to scroll back down. A keystroke or the
 * jump-to-latest control frees it; dragging the scrollbar does NOT. Programmatic
 * `scrollLines()` works fine in that state — so the buffer is healthy and it is the
 * user-driven (DOM viewport) path that is stuck.
 *
 * No local reproduction exists, so this records the real thing instead: a snapshot of the
 * buffer AND the DOM scroller either side of every user scroll attempt, plus the moments a
 * pane is hidden/shown. Written to the host log (scope `scrolldiag`) — Settings → Reveal logs.
 */

import { logToHost } from './bridge';

interface DiagTerminal {
  rows: number;
  cols: number;
  buffer: { active: { viewportY: number; baseY: number; length: number; type: string } };
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { height?: number }; canvas?: { height?: number } } };
    };
    _bufferService?: { isUserScrolling?: boolean };
  };
}

/** Everything needed to tell a stuck viewport from a stuck buffer, in one flat record. */
function snapshotScrollState(
  term: DiagTerminal,
  container: HTMLElement | null,
): Record<string, unknown> {
  const buf = term.buffer.active;
  const dims = term._core?._renderService?.dimensions;
  // xterm 5 scrolls a real overflow div; xterm 6 uses a scrollable element. Record whichever.
  const vp = container?.querySelector('.xterm-viewport') as HTMLElement | null;
  const sc = container?.querySelector('.xterm-scrollable-element') as HTMLElement | null;
  const area = container?.querySelector('.xterm-scroll-area') as HTMLElement | null;
  const el = sc ?? vp;
  return {
    ydisp: buf.viewportY,
    ybase: buf.baseY,
    behind: buf.baseY - buf.viewportY,
    lines: buf.length,
    bufType: buf.type,
    rows: term.rows,
    cols: term.cols,
    cellH: dims?.css?.cell?.height ?? null,
    canvasH: dims?.css?.canvas?.height ?? null,
    isUserScrolling: term._core?._bufferService?.isUserScrolling ?? null,
    // The DOM side of the scroll. If these can't express `lines`, user scrolling is capped.
    domScrollTop: el ? Math.round(el.scrollTop) : null,
    domScrollH: el?.scrollHeight ?? null,
    domClientH: el?.clientHeight ?? null,
    scrollAreaH: area?.style.height ?? null,
    // Is this pane actually on screen right now?
    visible: container ? container.offsetParent !== null : null,
    paneW: container?.offsetWidth ?? null,
    paneH: container?.offsetHeight ?? null,
  };
}

/**
 * Attach the recorders. Returns a disposer.
 *
 * Every user scroll attempt is logged BEFORE and AFTER (next frame), so a scroll that the
 * DOM accepted but the buffer ignored — or vice versa — is visible as a pair. Wheel and
 * scrollbar are recorded separately because the report says they behave differently.
 */
export function attachScrollDiagnostics(
  sessionId: string,
  term: DiagTerminal,
  container: HTMLElement,
): () => void {
  const emit = (event: string, extra?: Record<string, unknown>) => {
    logToHost(`scroll ${event}`, {
      scope: 'scrolldiag',
      data: { sessionId, event, ...snapshotScrollState(term, container), ...extra },
    });
  };

  // Pair each attempt with its outcome one frame later; that delta is the whole question.
  const around = (event: string) => {
    const before = snapshotScrollState(term, container);
    requestAnimationFrame(() => {
      const after = snapshotScrollState(term, container);
      logToHost(`scroll ${event}`, {
        scope: 'scrolldiag',
        data: {
          sessionId,
          event,
          movedYdisp: (after.ydisp as number) - (before.ydisp as number),
          movedDomScrollTop: (after.domScrollTop as number) - (before.domScrollTop as number),
          before,
          after,
        },
      });
    });
  };

  const onWheel = (e: WheelEvent) => around(`wheel(${e.deltaY > 0 ? 'down' : 'up'})`);
  // Capture phase so it is recorded even if something downstream stops the event.
  container.addEventListener('wheel', onWheel, { capture: true, passive: true });

  // The scrollbar drag path — reported as NOT freeing the lock, unlike a keystroke.
  const scroller = container.querySelector('.xterm-viewport') as HTMLElement | null;
  const onDomScroll = () => around('domscroll');
  scroller?.addEventListener('scroll', onDomScroll, { passive: true });

  const onKey = () => around('keydown');
  container.addEventListener('keydown', onKey, { capture: true });

  // Hidden ↔ shown is the trigger condition in the report, so mark the transitions.
  let wasVisible = container.offsetParent !== null;
  const ro = new ResizeObserver(() => {
    const now = container.offsetParent !== null;
    if (now !== wasVisible) {
      wasVisible = now;
      emit(now ? 'pane-shown' : 'pane-hidden');
    }
  });
  ro.observe(container);

  emit('attached');

  return () => {
    container.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
    scroller?.removeEventListener('scroll', onDomScroll);
    container.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
    ro.disconnect();
  };
}
