// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOTION_IDLE_MS, shouldPauseMotion, startMotionPause } from '../../webview/motion-pause';

describe('shouldPauseMotion', () => {
  it.each([
    [{ focused: true, hidden: false, idleMs: 0 }, false],
    [{ focused: true, hidden: false, idleMs: MOTION_IDLE_MS - 1 }, false],
    [{ focused: false, hidden: false, idleMs: 0 }, true],
    [{ focused: true, hidden: true, idleMs: 0 }, true],
    [{ focused: true, hidden: false, idleMs: MOTION_IDLE_MS }, true],
    [{ focused: false, hidden: true, idleMs: 0 }, true],
  ])('%j -> %s', (state, expected) => {
    expect(shouldPauseMotion(state)).toBe(expected);
  });

  it('idles after 60 s', () => {
    expect(MOTION_IDLE_MS).toBe(60_000);
  });
});

describe('startMotionPause', () => {
  const root = document.documentElement;
  let stop: (() => void) | null = null;
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    stop?.();
    stop = null;
    delete root.dataset.motionPaused;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function start() {
    stop = startMotionPause({
      win: window,
      doc: document,
      now: () => Date.now(),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });
    return stop;
  }

  const paused = () => root.dataset.motionPaused === 'true';

  it('starts unpaused when the window is focused', () => {
    start();
    expect(paused()).toBe(false);
    expect(root.hasAttribute('data-motion-paused')).toBe(false);
  });

  it('starts paused when the window is not focused', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    start();
    expect(paused()).toBe(true);
  });

  it('pauses on blur and resumes on focus', () => {
    start();
    window.dispatchEvent(new Event('blur'));
    expect(paused()).toBe(true);
    window.dispatchEvent(new Event('focus'));
    expect(paused()).toBe(false);
  });

  it('pauses while the document is hidden and resumes when visible', () => {
    start();
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(paused()).toBe(true);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(paused()).toBe(false);
  });

  it('pauses after 60 s without input', () => {
    start();
    vi.advanceTimersByTime(MOTION_IDLE_MS - 1);
    expect(paused()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(paused()).toBe(true);
  });

  it('input resumes a paused window and restarts the idle countdown', () => {
    start();
    vi.advanceTimersByTime(MOTION_IDLE_MS);
    expect(paused()).toBe(true);
    window.dispatchEvent(new Event('pointerdown'));
    expect(paused()).toBe(false);
    vi.advanceTimersByTime(MOTION_IDLE_MS - 1);
    expect(paused()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(paused()).toBe(true);
  });

  it('input near the idle limit pushes the pause back', () => {
    start();
    vi.advanceTimersByTime(MOTION_IDLE_MS - 1_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(5_000);
    expect(paused()).toBe(false);
    vi.advanceTimersByTime(MOTION_IDLE_MS - 5_000);
    expect(paused()).toBe(true);
  });

  it('every input kind counts as activity', () => {
    start();
    vi.advanceTimersByTime(MOTION_IDLE_MS);
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel']) {
      window.dispatchEvent(new Event(type));
      expect(paused(), type).toBe(false);
      vi.advanceTimersByTime(MOTION_IDLE_MS);
      expect(paused(), type).toBe(true);
    }
  });

  it('keeps the pause while blurred even when input arrives', () => {
    start();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('keydown'));
    expect(paused()).toBe(true);
  });

  it('cleanup removes the attribute, every listener and the pending timer', () => {
    const cleanup = start();
    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    stop = null;
    expect(paused()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    hidden = true;
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('keydown'));
    expect(root.hasAttribute('data-motion-paused')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
