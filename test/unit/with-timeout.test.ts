import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../../src/with-timeout';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise value when it settles before the timeout', async () => {
    const p = Promise.resolve('ok');
    await expect(withTimeout(p, 1000, 'fallback')).resolves.toBe('ok');
  });

  it('resolves with the fallback when the promise never settles', async () => {
    const never = new Promise<string>(() => {});
    const wrapped = withTimeout(never, 1000, 'fallback');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(wrapped).resolves.toBe('fallback');
  });

  it('does not fire the fallback once the promise has resolved', async () => {
    let resolveInner: (v: string) => void = () => {};
    const inner = new Promise<string>((r) => {
      resolveInner = r;
    });
    const wrapped = withTimeout(inner, 1000, 'fallback');
    resolveInner('real');
    await expect(wrapped).resolves.toBe('real');
    // Advancing past the timeout must not change the already-settled value.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(wrapped).resolves.toBe('real');
  });

  it('propagates rejection when the promise rejects before the timeout', async () => {
    const p = Promise.reject(new Error('boom'));
    await expect(withTimeout(p, 1000, 'fallback')).rejects.toThrow('boom');
  });

  it('clears the timer once the promise settles (no dangling timeout)', async () => {
    const p = Promise.resolve('ok');
    await withTimeout(p, 1000, 'fallback');
    expect(vi.getTimerCount()).toBe(0);
  });
});
