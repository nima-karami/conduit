import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { type AutoSaveMode, DEFAULT_SETTINGS } from '../../src/settings';
import {
  createQuitResponder,
  FLUSH_BOUND_MS,
  type QuitResponderDeps,
  SETTLE_BOUND_MS,
} from '../../webview/quit-responder';
import type { DirtyAnswer, DirtyAsk } from '../../webview/use-dirty-close';

type ConfirmQuitMsg = Extract<HostToWebview, { type: 'confirmQuit' }>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function confirm(overrides: Partial<ConfirmQuitMsg> = {}): ConfirmQuitMsg {
  return { type: 'confirmQuit', requestId: 1, reason: 'quit', running: 0, busy: 0, ...overrides };
}

function setup(
  opts: {
    mode?: AutoSaveMode;
    dirty?: string[];
    dirtyAnswer?: () => Promise<DirtyAnswer>;
    sessionsAnswer?: () => Promise<boolean>;
    flushAll?: () => Promise<void>;
    whenIdle?: () => Promise<void>;
  } = {},
) {
  const posts: WebviewToHost[] = [];
  const dirtyAsks: DirtyAsk[] = [];
  const sessionAsks: Parameters<QuitResponderDeps['askSessions']>[0][] = [];
  const deps = {
    post: vi.fn((m: WebviewToHost) => {
      posts.push(m);
    }),
    autoSaveMode: () => opts.mode ?? 'off',
    saves: {
      flushAll: vi.fn(opts.flushAll ?? (() => Promise.resolve())),
      whenIdle: vi.fn(opts.whenIdle ?? (() => Promise.resolve())),
      setToastsSuppressed: vi.fn(),
    },
    dirtyPaths: () => opts.dirty ?? [],
    askDirty: vi.fn((req: DirtyAsk) => {
      dirtyAsks.push(req);
      return opts.dirtyAnswer ? opts.dirtyAnswer() : Promise.resolve<DirtyAnswer>('saved');
    }),
    askSessions: vi.fn((req: Parameters<QuitResponderDeps['askSessions']>[0]) => {
      sessionAsks.push(req);
      return opts.sessionsAnswer ? opts.sessionsAnswer() : Promise.resolve(true);
    }),
    focusDialog: vi.fn(),
    setLocked: vi.fn(),
    wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    log: vi.fn(),
    flushSettings: vi.fn(() => {
      if (!settings.pending) return;
      settings.pending = false;
      posts.push({ type: 'updateSettings', settings: DEFAULT_SETTINGS });
    }),
  } satisfies QuitResponderDeps;
  const settings = { pending: true };
  const responder = createQuitResponder(deps);
  const decisions = () => posts.filter((p) => p.type === 'quitDecision');
  return { responder, deps, posts, dirtyAsks, sessionAsks, decisions, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('quit responder', () => {
  it('posts quitAck before anything else', async () => {
    const t = setup({ dirty: ['/a.ts'] });
    await t.responder.onConfirmQuit(confirm({ requestId: 7 }));
    expect(t.posts[0]).toEqual({ type: 'quitAck', requestId: 7 });
  });

  it('flushes pending settings synchronously on the ask, ahead of the decision', async () => {
    const t = setup();
    const flow = t.responder.onConfirmQuit(confirm({ requestId: 3 }));
    expect(t.deps.flushSettings).toHaveBeenCalledTimes(1);
    await flow;
    expect(t.posts.map((p) => p.type)).toEqual(['quitAck', 'updateSettings', 'quitDecision']);
  });

  it('flushes an edit made while the dialog was up before posting proceed', async () => {
    const answer = deferred<DirtyAnswer>();
    const t = setup({ dirty: ['/a.ts'], dirtyAnswer: () => answer.promise });
    const flow = t.responder.onConfirmQuit(confirm({ requestId: 4 }));
    await vi.advanceTimersByTimeAsync(0);
    t.settings.pending = true;
    answer.resolve('saved');
    await flow;
    expect(t.posts.map((p) => p.type)).toEqual([
      'quitAck',
      'updateSettings',
      'updateSettings',
      'quitDecision',
    ]);
  });

  it('re-probe while asking focuses, posts nothing', async () => {
    const answer = deferred<DirtyAnswer>();
    const t = setup({ dirty: ['/a.ts'], dirtyAnswer: () => answer.promise });
    void t.responder.onConfirmQuit(confirm());
    await vi.advanceTimersByTimeAsync(0);
    const before = t.posts.length;
    await t.responder.onConfirmQuit(confirm());
    expect(t.deps.focusDialog).toHaveBeenCalledTimes(1);
    expect(t.posts.length).toBe(before);
    expect(t.deps.askDirty).toHaveBeenCalledTimes(1);
  });

  it('re-probe after done answers proceed:false', async () => {
    const t = setup();
    await t.responder.onConfirmQuit(confirm({ requestId: 3 }));
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 3, proceed: true }]);
    await t.responder.onConfirmQuit(confirm({ requestId: 3 }));
    expect(t.decisions()).toEqual([
      { type: 'quitDecision', requestId: 3, proceed: true },
      { type: 'quitDecision', requestId: 3, proceed: false },
    ]);
    expect(t.posts.filter((p) => p.type === 'quitAck')).toHaveLength(1);
  });

  it('re-probe while flushing/settling is ignored', async () => {
    const flush = deferred<void>();
    const idle = deferred<void>();
    const t = setup({
      mode: 'afterDelay',
      flushAll: () => flush.promise,
      whenIdle: () => idle.promise,
    });
    const run = t.responder.onConfirmQuit(confirm());
    await vi.advanceTimersByTimeAsync(0);
    const afterAck = t.posts.length;
    await t.responder.onConfirmQuit(confirm());
    expect(t.posts.length).toBe(afterAck);
    expect(t.deps.focusDialog).not.toHaveBeenCalled();

    flush.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.deps.saves.whenIdle).toHaveBeenCalled();
    await t.responder.onConfirmQuit(confirm());
    expect(t.posts.length).toBe(afterAck);
    expect(t.deps.focusDialog).not.toHaveBeenCalled();

    idle.resolve();
    await run;
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 1, proceed: true }]);
  });

  it.each<[DirtyAnswer, boolean]>([
    ['discarded', true],
    ['saved', false],
    ['cancel', false],
  ])("Don't Save sets discarded; Save All and Cancel don't (%s)", async (answer, expected) => {
    const t = setup({ dirty: ['/a.ts'], dirtyAnswer: () => Promise.resolve(answer) });
    expect(t.responder.discarded()).toBe(false);
    await t.responder.onConfirmQuit(confirm());
    expect(t.responder.discarded()).toBe(expected);
  });

  it('quitAborted or a new ask clears discarded', async () => {
    const t = setup({ dirty: ['/a.ts'], dirtyAnswer: () => Promise.resolve('discarded') });
    await t.responder.onConfirmQuit(confirm({ requestId: 1 }));
    expect(t.responder.discarded()).toBe(true);
    t.responder.onQuitAborted(1);
    expect(t.responder.discarded()).toBe(false);

    const hold = deferred<DirtyAnswer>();
    const u = setup({
      dirty: ['/a.ts'],
      dirtyAnswer: () => (u.dirtyAsks.length === 1 ? Promise.resolve('discarded') : hold.promise),
    });
    await u.responder.onConfirmQuit(confirm({ requestId: 1, reason: 'windowClose' }));
    expect(u.responder.discarded()).toBe(true);
    void u.responder.onConfirmQuit(confirm({ requestId: 2 }));
    expect(u.responder.discarded()).toBe(false);
  });

  it.each<DirtyAnswer>(['saved', 'discarded', 'cancel'])(
    'quitAborted for the in-flight id ends the flow (late %s)',
    async (late) => {
      const answer = deferred<DirtyAnswer>();
      const t = setup({ dirty: ['/a.ts'], dirtyAnswer: () => answer.promise });
      const run = t.responder.onConfirmQuit(confirm({ requestId: 5 }));
      await vi.advanceTimersByTimeAsync(0);
      const signal = t.dirtyAsks[0]?.signal;
      expect(signal?.aborted).toBe(false);
      t.responder.onQuitAborted(5);
      expect(signal?.aborted).toBe(true);
      answer.resolve(late);
      await run;
      await vi.advanceTimersByTimeAsync(SETTLE_BOUND_MS);
      expect(t.decisions()).toEqual([]);
      expect(t.deps.setLocked).not.toHaveBeenCalledWith(true);
      expect(t.responder.discarded()).toBe(false);
    },
  );

  it('quitAborted while the session confirm is open posts nothing when it later resolves', async () => {
    const answer = deferred<boolean>();
    const t = setup({ sessionsAnswer: () => answer.promise });
    const run = t.responder.onConfirmQuit(confirm({ requestId: 6, running: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    t.responder.onQuitAborted(6);
    expect(t.sessionAsks[0]?.signal.aborted).toBe(true);
    answer.resolve(false);
    await run;
    expect(t.decisions()).toEqual([]);
  });

  it('quitAborted during flushing never opens a dialog', async () => {
    const flush = deferred<void>();
    const t = setup({ mode: 'afterDelay', dirty: ['/a.ts'], flushAll: () => flush.promise });
    const run = t.responder.onConfirmQuit(confirm({ requestId: 8 }));
    await vi.advanceTimersByTimeAsync(0);
    t.responder.onQuitAborted(8);
    flush.resolve();
    await run;
    expect(t.deps.askDirty).not.toHaveBeenCalled();
    expect(t.decisions()).toEqual([]);
    expect(t.deps.saves.setToastsSuppressed).toHaveBeenLastCalledWith(false);
  });

  it("a superseded flow leaves the new flow's toast suppression on", async () => {
    const first = deferred<DirtyAnswer>();
    const flush2 = deferred<void>();
    const t = setup({
      mode: 'afterDelay',
      dirty: ['/a.ts'],
      dirtyAnswer: () => first.promise,
      flushAll: () =>
        t.deps.saves.flushAll.mock.calls.length === 1 ? Promise.resolve() : flush2.promise,
    });
    const run1 = t.responder.onConfirmQuit(confirm({ requestId: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const run2 = t.responder.onConfirmQuit(confirm({ requestId: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    first.resolve('cancel');
    await run1;
    expect(t.deps.saves.setToastsSuppressed).toHaveBeenLastCalledWith(true);
    flush2.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await run2;
    expect(t.deps.saves.setToastsSuppressed).toHaveBeenLastCalledWith(false);
  });

  it('quitAborted during settling never locks or posts', async () => {
    const idle = deferred<void>();
    const t = setup({ whenIdle: () => idle.promise });
    const run = t.responder.onConfirmQuit(confirm({ requestId: 5 }));
    await vi.advanceTimersByTimeAsync(0);
    t.responder.onQuitAborted(5);
    idle.resolve();
    await run;
    expect(t.decisions()).toEqual([]);
    expect(t.deps.setLocked).not.toHaveBeenCalled();
  });

  it('a new request ends the previous flow silently', async () => {
    const first = deferred<DirtyAnswer>();
    const t = setup({
      dirty: ['/a.ts'],
      dirtyAnswer: () => (t.dirtyAsks.length === 1 ? first.promise : Promise.resolve('saved')),
    });
    const run1 = t.responder.onConfirmQuit(confirm({ requestId: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    await t.responder.onConfirmQuit(confirm({ requestId: 2 }));
    expect(t.dirtyAsks[0]?.signal?.aborted).toBe(true);
    first.resolve('saved');
    await run1;
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 2, proceed: true }]);
  });

  it('quitAborted for the locked id unlocks', async () => {
    const t = setup();
    await t.responder.onConfirmQuit(confirm({ requestId: 4 }));
    expect(t.deps.setLocked).toHaveBeenLastCalledWith(true);
    t.responder.onQuitAborted(4);
    expect(t.deps.setLocked).toHaveBeenLastCalledWith(false);
  });

  it('off mode: no flush, no suppression', async () => {
    const t = setup({ mode: 'off' });
    await t.responder.onConfirmQuit(confirm());
    expect(t.deps.saves.flushAll).not.toHaveBeenCalled();
    expect(t.deps.saves.setToastsSuppressed).not.toHaveBeenCalledWith(true);
  });

  it('autoSave on: flush raced against 5 s', async () => {
    const t = setup({ mode: 'onFocusChange', flushAll: () => new Promise<void>(() => {}) });
    const run = t.responder.onConfirmQuit(confirm());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.deps.saves.flushAll).toHaveBeenCalledWith('windowBlur');
    expect(t.deps.saves.setToastsSuppressed).toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(FLUSH_BOUND_MS - 1);
    expect(t.decisions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 1, proceed: true }]);
  });

  it('nothing dirty + running 0 → proceed, no ask', async () => {
    const t = setup();
    await t.responder.onConfirmQuit(confirm());
    expect(t.deps.askDirty).not.toHaveBeenCalled();
    expect(t.deps.askSessions).not.toHaveBeenCalled();
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 1, proceed: true }]);
  });

  it.each([true, false])('nothing dirty + running → askSessions (answer %s)', async (ok) => {
    const t = setup({ sessionsAnswer: () => Promise.resolve(ok) });
    await t.responder.onConfirmQuit(confirm({ running: 2, busy: 1, reason: 'update' }));
    expect(t.deps.askDirty).not.toHaveBeenCalled();
    expect(t.sessionAsks).toHaveLength(1);
    expect(t.sessionAsks[0]).toMatchObject({ reason: 'update', running: 2, busy: 1 });
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 1, proceed: ok }]);
  });

  it('dirty → askDirty with running/busy/reason', async () => {
    const t = setup({ dirty: ['/a.ts', '/b.ts'] });
    await t.responder.onConfirmQuit(confirm({ reason: 'windowClose', running: 3, busy: 2 }));
    expect(t.deps.askSessions).not.toHaveBeenCalled();
    expect(t.dirtyAsks[0]).toMatchObject({
      reason: 'windowClose',
      paths: ['/a.ts', '/b.ts'],
      running: 3,
      busy: 2,
    });
    expect(t.dirtyAsks[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('onShown posts quitDialogShown{requestId}', async () => {
    const t = setup({ dirty: ['/a.ts'] });
    await t.responder.onConfirmQuit(confirm({ requestId: 9 }));
    t.dirtyAsks[0]?.onShown?.();
    expect(t.posts).toContainEqual({ type: 'quitDialogShown', requestId: 9 });

    const u = setup();
    await u.responder.onConfirmQuit(confirm({ requestId: 10, running: 1 }));
    u.sessionAsks[0]?.onShown();
    expect(u.posts).toContainEqual({ type: 'quitDialogShown', requestId: 10 });
  });

  it('proceed waits whenIdle bounded 5 s then posts', async () => {
    const idle = deferred<void>();
    const t = setup({ whenIdle: () => idle.promise });
    const run = t.responder.onConfirmQuit(confirm());
    await vi.advanceTimersByTimeAsync(SETTLE_BOUND_MS - 1);
    expect(t.decisions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 1, proceed: true }]);
    expect(t.deps.log).toHaveBeenCalledTimes(1);

    const u = setup();
    await u.responder.onConfirmQuit(confirm());
    expect(u.decisions()).toHaveLength(1);
    expect(u.deps.log).not.toHaveBeenCalled();
  });

  it.each<[ConfirmQuitMsg['reason'], boolean]>([
    ['windowClose', false],
    ['quit', true],
    ['update', true],
  ])(
    'windowClose proceed does not lock; quit/update proceed locks before posting (%s)',
    async (reason, locks) => {
      const t = setup();
      let lockedBeforeDecision = false;
      t.deps.post.mockImplementation((m: WebviewToHost) => {
        if (m.type === 'quitDecision')
          lockedBeforeDecision = t.deps.setLocked.mock.calls.length > 0;
        t.posts.push(m);
      });
      await t.responder.onConfirmQuit(confirm({ reason }));
      expect(t.deps.setLocked).toHaveBeenCalledTimes(locks ? 1 : 0);
      expect(lockedBeforeDecision).toBe(locks);
    },
  );

  it('cancel posts proceed:false', async () => {
    const t = setup({ dirty: ['/a.ts'], dirtyAnswer: () => Promise.resolve('cancel') });
    await t.responder.onConfirmQuit(confirm());
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 1, proceed: false }]);
    expect(t.deps.setLocked).not.toHaveBeenCalled();
    expect(t.deps.saves.whenIdle).not.toHaveBeenCalled();
  });

  it('suppression cleared in finally, even on throw', async () => {
    const t = setup({
      mode: 'afterDelay',
      dirty: ['/a.ts'],
      dirtyAnswer: () => Promise.reject(new Error('boom')),
    });
    await expect(t.responder.onConfirmQuit(confirm())).rejects.toThrow('boom');
    expect(t.deps.saves.setToastsSuppressed.mock.calls).toEqual([[true], [false]]);

    const u = setup({ mode: 'afterDelay' });
    await u.responder.onConfirmQuit(confirm());
    expect(u.deps.saves.setToastsSuppressed).toHaveBeenLastCalledWith(false);
  });

  it('onQuitAborted with an unknown id is ignored', async () => {
    const answer = deferred<DirtyAnswer>();
    const t = setup({ dirty: ['/a.ts'], dirtyAnswer: () => answer.promise });
    const run = t.responder.onConfirmQuit(confirm({ requestId: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    t.responder.onQuitAborted(99);
    expect(t.dirtyAsks[0]?.signal?.aborted).toBe(false);
    expect(t.deps.setLocked).not.toHaveBeenCalled();
    answer.resolve('discarded');
    await run;
    t.responder.onQuitAborted(99);
    expect(t.responder.discarded()).toBe(true);
    expect(t.decisions()).toEqual([{ type: 'quitDecision', requestId: 1, proceed: true }]);
  });
});
