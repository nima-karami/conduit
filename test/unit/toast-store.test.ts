import { describe, expect, it, vi } from 'vitest';
import {
  __resetToastsForTest,
  dismissToast,
  getToastsSnapshot,
  pushToast,
  subscribeToasts,
} from '../../webview/toast-store';

describe('toast-store — push / dismiss / subscribe', () => {
  it('push adds a toast and notifies subscribers', () => {
    __resetToastsForTest();
    const seen = vi.fn();
    const off = subscribeToasts(seen);
    pushToast({ message: 'saved failed', variant: 'error', durationMs: 0 });
    expect(getToastsSnapshot()).toHaveLength(1);
    expect(getToastsSnapshot()[0].message).toBe('saved failed');
    expect(getToastsSnapshot()[0].variant).toBe('error');
    expect(seen).toHaveBeenCalled();
    off();
  });

  it('returns a stable snapshot reference until the list changes', () => {
    __resetToastsForTest();
    const a = getToastsSnapshot();
    expect(getToastsSnapshot()).toBe(a); // no change -> same reference
    pushToast({ message: 'x', variant: 'info', durationMs: 0 });
    expect(getToastsSnapshot()).not.toBe(a); // changed -> new reference
  });

  it('dismiss removes the toast by id', () => {
    __resetToastsForTest();
    const id = pushToast({ message: 'gone soon', variant: 'info', durationMs: 0 });
    expect(getToastsSnapshot()).toHaveLength(1);
    dismissToast(id);
    expect(getToastsSnapshot()).toHaveLength(0);
  });

  it('dismissing an unknown id is a harmless no-op', () => {
    __resetToastsForTest();
    pushToast({ message: 'stays', variant: 'info', durationMs: 0 });
    expect(() => dismissToast('nope')).not.toThrow();
    expect(getToastsSnapshot()).toHaveLength(1);
  });

  it('auto-dismisses after the duration elapses', () => {
    vi.useFakeTimers();
    __resetToastsForTest();
    pushToast({ message: 'auto', variant: 'info', durationMs: 5000 });
    expect(getToastsSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(getToastsSnapshot()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('assigns distinct ids to successive toasts', () => {
    __resetToastsForTest();
    const id1 = pushToast({ message: 'a', variant: 'info', durationMs: 0 });
    const id2 = pushToast({ message: 'b', variant: 'info', durationMs: 0 });
    expect(id1).not.toBe(id2);
  });
});
