import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDebouncedFlush } from '../../webview/use-debounced-flush';

describe('makeDebouncedFlush', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules the callback after the delay', () => {
    const cb = vi.fn();
    const { schedule } = makeDebouncedFlush(cb, 300);
    schedule();
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('debounces: only fires once after multiple rapid calls', () => {
    const cb = vi.fn();
    const { schedule } = makeDebouncedFlush(cb, 300);
    schedule();
    schedule();
    schedule();
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('flush fires immediately if a call is pending', () => {
    const cb = vi.fn();
    const { schedule, flush } = makeDebouncedFlush(cb, 300);
    schedule();
    expect(cb).not.toHaveBeenCalled();
    flush();
    expect(cb).toHaveBeenCalledTimes(1);
    // After flush, timer is cleared; advancing time must NOT fire again.
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing is pending', () => {
    const cb = vi.fn();
    const { flush } = makeDebouncedFlush(cb, 300);
    flush(); // nothing scheduled
    expect(cb).not.toHaveBeenCalled();
  });

  it('cancel prevents the scheduled callback from firing', () => {
    const cb = vi.fn();
    const { schedule, cancel } = makeDebouncedFlush(cb, 300);
    schedule();
    cancel();
    vi.advanceTimersByTime(300);
    expect(cb).not.toHaveBeenCalled();
  });
});
