import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInflightTracker,
  resetWarmGuardForTests,
  shouldWarm,
  warmLanguageWorker,
} from '../../webview/monaco-warmup';

describe('shouldWarm (module-scoped once-guard)', () => {
  beforeEach(() => resetWarmGuardForTests());

  it('returns true the first time, false thereafter', () => {
    expect(shouldWarm()).toBe(true);
    expect(shouldWarm()).toBe(false);
    expect(shouldWarm()).toBe(false);
  });
});

describe('createInflightTracker (ref-counted, observable)', () => {
  it('active() is true while begin > end, false when balanced; never negative', () => {
    const t = createInflightTracker();
    expect(t.active()).toBe(false);
    t.begin();
    expect(t.active()).toBe(true);
    t.begin();
    expect(t.active()).toBe(true);
    t.end();
    expect(t.active()).toBe(true);
    t.end();
    expect(t.active()).toBe(false);
    t.end(); // extra end must not go negative
    expect(t.active()).toBe(false);
  });

  it('notifies subscribers on 0<->>=1 transitions and supports unsubscribe', () => {
    const t = createInflightTracker();
    const seen: boolean[] = [];
    const unsub = t.subscribe(() => seen.push(t.active()));
    t.begin(); // false -> true (notify)
    t.begin(); // stays true (no transition)
    t.end(); // stays true
    t.end(); // true -> false (notify)
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    unsub();
    const before = seen.length;
    t.begin();
    expect(seen.length).toBe(before); // no notify after unsubscribe
  });
});

describe('warmLanguageWorker', () => {
  beforeEach(() => resetWarmGuardForTests());

  it('acquires the worker once, however many times it is triggered', async () => {
    const acquire = vi.fn().mockResolvedValue(undefined);
    await warmLanguageWorker({ acquire });
    await warmLanguageWorker({ acquire });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  // Pushing indexed content doesn't start the worker (monaco's _updateExtraLibs returns early
  // when there isn't one), so a failed warm-up must stay retryable or nothing warms it.
  it('un-latches the guard when acquisition throws, allowing a retry', async () => {
    const acquire = vi.fn().mockRejectedValue(new Error('boom'));
    await warmLanguageWorker({ acquire });
    expect(shouldWarm()).toBe(true);
  });

  it('swallows the failure rather than rejecting into a fire-and-forget caller', async () => {
    await expect(
      warmLanguageWorker({ acquire: () => Promise.reject(new Error('boom')) }),
    ).resolves.toBeUndefined();
  });
});
