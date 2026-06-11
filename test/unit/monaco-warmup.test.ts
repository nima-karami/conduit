import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInflightTracker,
  resetWarmGuardForTests,
  shouldWarm,
  warmTypeScriptWorker,
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

describe('warmTypeScriptWorker', () => {
  beforeEach(() => resetWarmGuardForTests());

  const tsModel = { uri: 'file:///a.tsx', languageId: 'typescriptreact' };
  const isTs = (id: string) => id.startsWith('typescript') || id.startsWith('javascript');

  it('acquires the worker and issues the real getDefinitionAtPosition on the first TS model', async () => {
    const getDef = vi.fn().mockResolvedValue([]);
    const getWorker = vi
      .fn()
      .mockResolvedValue(() => Promise.resolve({ getDefinitionAtPosition: getDef }));
    await warmTypeScriptWorker({
      getModels: () => [{ uri: 'file:///x.css', languageId: 'css' }, tsModel],
      isTsLang: isTs,
      getTypeScriptWorker: getWorker,
    });
    expect(getWorker).toHaveBeenCalledTimes(1);
    expect(getDef).toHaveBeenCalledWith('file:///a.tsx', 0);
  });

  it('runs only once even if called again', async () => {
    const getWorker = vi
      .fn()
      .mockResolvedValue(() => Promise.resolve({ getDefinitionAtPosition: vi.fn() }));
    const deps = {
      getModels: () => [tsModel],
      isTsLang: isTs,
      getTypeScriptWorker: getWorker,
    };
    await warmTypeScriptWorker(deps);
    await warmTypeScriptWorker(deps);
    expect(getWorker).toHaveBeenCalledTimes(1);
  });

  it('no-ops (and does NOT latch the guard) when no TS model exists yet', async () => {
    const getWorker = vi.fn();
    await warmTypeScriptWorker({
      getModels: () => [{ uri: 'file:///x.css', languageId: 'css' }],
      isTsLang: isTs,
      getTypeScriptWorker: getWorker,
    });
    expect(getWorker).not.toHaveBeenCalled();
    expect(shouldWarm()).toBe(true); // guard not latched -> a real warm can still run
  });

  it('un-latches the guard when worker acquisition throws (allows retry)', async () => {
    const getWorker = vi.fn().mockRejectedValue(new Error('boom'));
    await warmTypeScriptWorker({
      getModels: () => [tsModel],
      isTsLang: isTs,
      getTypeScriptWorker: getWorker,
    });
    expect(shouldWarm()).toBe(true); // not latched after failure
  });
});
