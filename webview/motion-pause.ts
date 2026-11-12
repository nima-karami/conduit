/** Idle time after the last keyboard/pointer input before background motion pauses. */
export const MOTION_IDLE_MS = 60_000;

/** Pure decision: background motion runs only while the user is looking at the window. */
export function shouldPauseMotion(s: {
  focused: boolean;
  hidden: boolean;
  idleMs: number;
}): boolean {
  return !s.focused || s.hidden || s.idleMs >= MOTION_IDLE_MS;
}

/** Input that counts as the user being present. Passive and captured so nothing can swallow it. */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const;
const INPUT_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

export interface MotionPauseDeps {
  win: Window;
  doc: Document;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}

/**
 * Sets `data-motion-paused` on <html> while background motion should be frozen. The CSS
 * freezes in place (animation-play-state), so a resume continues the same frame rather than
 * restarting the sweep. Returns a cleanup that removes every listener, the timer and the attribute.
 */
export function startMotionPause(deps: MotionPauseDeps): () => void {
  const { win, doc, now, setTimer, clearTimer } = deps;
  const root = doc.documentElement;

  let focused = doc.hasFocus();
  let lastInput = now();
  let applied: boolean | null = null;
  // Armed whenever the window is not idle-paused, so input only has to move `lastInput`:
  // when the timer fires early it re-arms for the remainder instead of every move re-arming.
  let timer: ReturnType<typeof setTimeout> | null = null;

  const sync = () => {
    const pause = shouldPauseMotion({
      focused,
      hidden: doc.hidden,
      idleMs: now() - lastInput,
    });
    if (pause === applied) return;
    applied = pause;
    if (pause) root.dataset.motionPaused = 'true';
    else delete root.dataset.motionPaused;
  };

  const arm = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(onTimer, ms);
  };

  function onTimer() {
    timer = null;
    sync();
    const idleMs = now() - lastInput;
    if (idleMs < MOTION_IDLE_MS) arm(MOTION_IDLE_MS - idleMs);
  }

  const onInput = () => {
    lastInput = now();
    if (applied !== true) return;
    sync();
    arm(MOTION_IDLE_MS);
  };
  const onFocus = () => {
    focused = true;
    sync();
  };
  const onBlur = () => {
    focused = false;
    sync();
  };
  const onVisibility = () => sync();

  sync();
  arm(MOTION_IDLE_MS);

  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  for (const type of INPUT_EVENTS) win.addEventListener(type, onInput, INPUT_OPTIONS);

  return () => {
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
    for (const type of INPUT_EVENTS) win.removeEventListener(type, onInput, INPUT_OPTIONS);
    if (timer !== null) clearTimer(timer);
    timer = null;
    delete root.dataset.motionPaused;
  };
}
