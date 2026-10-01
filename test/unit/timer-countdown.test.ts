import { afterEach, expect, it, vi } from 'vitest';
import { startTimerCountdown } from '../../webview/timer-countdown';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('schedules no presentation work for a hidden pane in a visible window', () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const stop = startTimerCountdown(Date.now() + 30_000, false, vi.fn());
  expect(vi.getTimerCount()).toBe(0);
  stop();
});

it('ticks a shown countdown, pauses when the window hides, and disposes its listener', async () => {
  vi.useFakeTimers();
  let visibility = () => {};
  const doc = {
    visibilityState: 'visible',
    addEventListener: vi.fn((_name, cb) => {
      visibility = cb;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('document', doc);
  const tick = vi.fn();
  const stop = startTimerCountdown(Date.now() + 30_000, true, tick);
  await vi.advanceTimersByTimeAsync(1000);
  expect(tick).toHaveBeenCalledTimes(1);
  doc.visibilityState = 'hidden';
  visibility();
  expect(vi.getTimerCount()).toBe(0);
  doc.visibilityState = 'visible';
  visibility();
  expect(vi.getTimerCount()).toBe(1);
  stop();
  expect(vi.getTimerCount()).toBe(0);
  expect(doc.removeEventListener).toHaveBeenCalledTimes(1);
});
