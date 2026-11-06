import { describe, expect, it } from 'vitest';
import type { ServerChannel, SuperviseExit, TrayRelayDeps } from '../../server/tray/contracts';
import { createTrayRelay } from '../../server/tray/relay';
import { SERVER_EXIT } from '../../src/contracts/session-identity';
import type {
  HelperToSupervisor,
  ServerToSupervisor,
  SupervisorToHelper,
  SupervisorToServer,
  TrayCounts,
  TrayView,
  TrayViewInput,
} from '../../src/contracts/tray-protocol';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const counts = (running: number, needsYou = 0): TrayCounts => ({
  running,
  needsYou,
  health: 'ready',
  stopping: null,
});

/** A view that renders the whole input, so any input change is a view change. */
const echoView = (i: TrayViewInput): TrayView => ({
  visible: true,
  icon: 'normal',
  tooltip: JSON.stringify(i),
  items: [],
  confirm: { title: 'c', body: 'b', confirm: 'y', cancel: 'n' },
  openFailed: { title: 'o', body: 'f' },
});

function fakeChannel() {
  const sent: SupervisorToServer[] = [];
  const listeners = new Set<(m: ServerToSupervisor) => void>();
  let close: () => void = () => {};
  const closed = new Promise<void>((r) => {
    close = r;
  });
  const ch: ServerChannel = {
    send: (m) => {
      sent.push(m);
    },
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    closed,
  };
  return {
    ch,
    sent,
    emit: (m: ServerToSupervisor) => {
      for (const l of listeners) l(m);
    },
    close: () => close(),
  };
}

function harness(o: Partial<TrayRelayDeps> & { pollResults?: (number | null)[] } = {}) {
  let clock = 0;
  const timers: { at: number; ms: number; cb: () => void; cancelled: boolean }[] = [];
  const toHelper: SupervisorToHelper[] = [];
  const logs: { level: string; who: string; message: string }[] = [];
  let onHelper: (m: HelperToSupervisor) => void = () => {};
  let exitHelper: (c: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exitHelper = r;
  });
  let starts = 0;
  let polls = 0;
  const pollResults = o.pollResults ?? [];
  const deps: TrayRelayDeps = {
    tray: { source: '/src/conduit-tray.exe', app: { exe: '/app.exe', args: [], cwd: '/w' } },
    launcher: {
      start: async (cb) => {
        starts++;
        onHelper = cb;
        return {
          send: (m) => {
            toHelper.push(m);
          },
          exited,
          pid: 42,
        };
      },
    },
    view: echoView,
    pollRunning: async () => {
      polls++;
      return pollResults.length ? (pollResults.shift() ?? null) : null;
    },
    log: { write: (level, who, message) => logs.push({ level, who, message }) },
    seam: null,
    profileLabel: null,
    now: () => clock,
    setTimer: (ms, cb) => {
      const t = { at: clock + ms, ms, cb, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    ...o,
  };
  const relay = createTrayRelay(deps);
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      clock = next.at;
      next.cancelled = true;
      next.cb();
      await flush();
    }
    clock = end;
    await flush();
  };
  return {
    relay,
    toHelper,
    logs,
    advance,
    helper: (m: HelperToSupervisor) => onHelper(m),
    exitHelper: (c: number | null) => exitHelper(c),
    starts: () => starts,
    polls: () => polls,
    types: () => toHelper.map((m) => m.type),
    views: () =>
      toHelper.flatMap((m) =>
        m.type === 'view' ? [JSON.parse(m.view.tooltip) as TrayViewInput] : [],
      ),
  };
}

/** A server child that comes up and reports `n` running. */
async function serve(h: ReturnType<typeof harness>, n = 1) {
  const c = fakeChannel();
  h.relay.hooks.phase({ phase: 'spawning' });
  h.relay.attachServer(c.ch);
  c.emit({ type: 'ready' });
  c.emit({ type: 'counts', counts: counts(n) });
  await flush();
  return c;
}

describe('createTrayRelay — D3 start', () => {
  it('starts nothing before the first ready or crash', async () => {
    const h = harness();
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.attachServer(fakeChannel().ch);
    await flush();
    expect(h.starts()).toBe(0);
    expect(h.polls()).toBe(0);
  });

  it('starts once on the first ready, sends init with the app, then the view', async () => {
    const h = harness();
    await serve(h, 2);
    expect(h.starts()).toBe(1);
    expect(h.polls()).toBe(0);
    expect(h.toHelper[0]).toEqual({
      type: 'init',
      v: 1,
      app: { exe: '/app.exe', args: [], cwd: '/w' },
    });
    expect(h.views().at(-1)).toEqual({
      phase: { phase: 'serving' },
      source: { source: 'server', counts: counts(2) },
      profileLabel: null,
    });
    h.relay.hooks.childExit(1);
    await serve(h, 3);
    expect(h.starts()).toBe(1);
  });

  it.each([1, null])('AC13: a crash exit (%s) before any ready starts the helper', async (code) => {
    const h = harness({ pollResults: [2] });
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.attachServer(fakeChannel().ch);
    h.relay.hooks.childExit(code);
    h.relay.hooks.phase({ phase: 'restarting' });
    await flush();
    expect(h.starts()).toBe(1);
    expect(h.views().at(-1)).toEqual({
      phase: { phase: 'restarting' },
      source: { source: 'hc', running: 2, needsYou: null },
      profileLabel: null,
    });
  });

  it.each([SERVER_EXIT.done, SERVER_EXIT.doneCoreIdle])(
    'never starts on a %s exit',
    async (code) => {
      const h = harness();
      h.relay.hooks.phase({ phase: 'spawning' });
      h.relay.hooks.childExit(code);
      await flush();
      expect(h.starts()).toBe(0);
      await h.relay.finish({ reason: 'done' });
      expect(h.toHelper).toEqual([]);
    },
  );

  it('a throwing launcher is logged and supervision continues', async () => {
    const h = harness({
      launcher: {
        start: async () => {
          throw new Error('spawn exploded');
        },
      },
    });
    const c = fakeChannel();
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.attachServer(c.ch);
    expect(() => c.emit({ type: 'ready' })).not.toThrow();
    await flush();
    expect(h.logs.some((l) => l.level === 'error' && /spawn exploded/.test(l.message))).toBe(true);
    await h.relay.finish({ reason: 'doneCoreIdle' });
  });

  it('counts before ready are ignored: a server that never bound is no reading', async () => {
    const h = harness();
    const c = fakeChannel();
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.attachServer(c.ch);
    c.emit({ type: 'counts', counts: counts(5) });
    h.relay.hooks.childExit(1);
    await flush();
    expect(h.views().at(-1)?.source).toEqual({ source: 'none' });
  });

  it('a null launcher (no binary) leaves the relay inert', async () => {
    const h = harness({ launcher: { start: async () => null } });
    await serve(h);
    await h.relay.finish({ reason: 'done' });
    expect(h.toHelper).toEqual([]);
  });
});

describe('createTrayRelay — readings and views', () => {
  it('sends a view only when trayView output changes', async () => {
    const h = harness({
      view: (i) =>
        echoView({
          ...i,
          source: i.source.source === 'server' ? { source: 'server', counts: counts(9) } : i.source,
        }),
    });
    const c = await serve(h, 1);
    const n = h.types().filter((t) => t === 'view').length;
    c.emit({ type: 'counts', counts: counts(2) });
    c.emit({ type: 'counts', counts: counts(3) });
    expect(h.types().filter((t) => t === 'view').length).toBe(n);
  });

  it('a view change goes out; identical counts do not repeat it', async () => {
    const h = harness();
    const c = await serve(h, 1);
    const before = h.views().length;
    c.emit({ type: 'counts', counts: counts(1) });
    expect(h.views().length).toBe(before);
    c.emit({ type: 'counts', counts: counts(2, 1) });
    expect(h.views().length).toBe(before + 1);
  });

  it('polls hc only without a ready server, every 15 s, keeping the last good reading', async () => {
    const h = harness({ pollResults: [3, null, 4] });
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'restarting' });
    await flush();
    expect(h.polls()).toBe(1);
    expect(h.views().at(-1)?.source).toEqual({ source: 'hc', running: 3, needsYou: null });
    await h.advance(15_000);
    expect(h.polls()).toBe(2);
    expect(h.views().at(-1)?.source).toEqual({ source: 'hc', running: 3, needsYou: null });
    await h.advance(15_000);
    expect(h.views().at(-1)?.source).toEqual({ source: 'hc', running: 4, needsYou: null });

    await serve(h, 1);
    const polls = h.polls();
    await h.advance(60_000);
    expect(h.polls()).toBe(polls);
  });

  it('a poll that lands after a server became ready is discarded', async () => {
    let resolvePoll: (n: number | null) => void = () => {};
    const h = harness({
      pollRunning: () =>
        new Promise((r) => {
          resolvePoll = r;
        }),
    });
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.hooks.childExit(1);
    await flush();
    await serve(h, 1);
    resolvePoll(7);
    await flush();
    expect(h.views().at(-1)?.source).toEqual({ source: 'server', counts: counts(1) });
  });

  it('losing the server keeps its running count as the reading until hc answers', async () => {
    const h = harness();
    await serve(h, 2);
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'restarting' });
    await flush();
    expect(h.views().at(-1)).toEqual({
      phase: { phase: 'restarting' },
      source: { source: 'hc', running: 2, needsYou: null },
      profileLabel: null,
    });
  });

  it('counts from a stale channel are ignored', async () => {
    const h = harness();
    const old = await serve(h, 1);
    h.relay.hooks.childExit(1);
    await serve(h, 2);
    old.emit({ type: 'counts', counts: counts(5) });
    expect(h.views().at(-1)?.source).toEqual({ source: 'server', counts: counts(2) });
  });

  it('a throwing view is logged, never thrown into supervise()', async () => {
    const h = harness({
      view: () => {
        throw new Error('view bug');
      },
    });
    h.relay.hooks.phase({ phase: 'spawning' });
    expect(() => h.relay.hooks.childExit(1)).not.toThrow();
    expect(() => h.relay.hooks.phase({ phase: 'restarting' })).not.toThrow();
    await flush();
    expect(h.logs.some((l) => /view bug/.test(l.message))).toBe(true);
  });

  it('writes helper log messages to the tray log as the helper', async () => {
    const h = harness();
    await serve(h);
    h.helper({ type: 'log', level: 'warn', message: 'NIM_ADD failed' });
    expect(h.logs).toContainEqual({ level: 'warn', who: 'helper', message: 'NIM_ADD failed' });
  });
});

describe('createTrayRelay — F3 stop routing', () => {
  it('serving: one IPC stopAll per helper stopAll; ok → stopResult ok', async () => {
    const h = harness();
    const c = await serve(h, 2);
    h.helper({ type: 'stopAll' });
    expect(c.sent).toEqual([{ type: 'stopAll', id: 1 }]);
    c.emit({ type: 'stopAllResult', id: 1, ok: true, killed: 2 });
    expect(h.toHelper.at(-1)).toEqual({ type: 'stopResult', ok: true });
    h.helper({ type: 'stopAll' });
    expect(c.sent).toEqual([
      { type: 'stopAll', id: 1 },
      { type: 'stopAll', id: 2 },
    ]);
    expect(h.relay.stopSignal.aborted).toBe(false);
    expect(h.logs.some((l) => /stopAll.*id=1/.test(l.message))).toBe(true);
  });

  it('serving: a failed answer → stopResult ok:false with the reason', async () => {
    const h = harness();
    const c = await serve(h);
    h.helper({ type: 'stopAll' });
    c.emit({ type: 'stopAllResult', id: 1, ok: false, reason: 'already stopping' });
    const last = h.toHelper.at(-1);
    expect(last).toMatchObject({ type: 'stopResult', ok: false });
    expect(last?.type === 'stopResult' && !last.ok && last.body).toMatch(/already stopping/);
  });

  it('serving: no answer within 20 s → stopResult ok:false, and a late answer is ignored', async () => {
    const h = harness();
    const c = await serve(h);
    h.helper({ type: 'stopAll' });
    await h.advance(19_999);
    expect(h.types()).not.toContain('stopResult');
    await h.advance(1);
    expect(h.toHelper.at(-1)).toMatchObject({ type: 'stopResult', ok: false });
    c.emit({ type: 'stopAllResult', id: 1, ok: true, killed: 1 });
    expect(h.types().filter((t) => t === 'stopResult')).toHaveLength(1);
  });

  it('serving: the channel closing before the answer → stopResult ok:false', async () => {
    const h = harness();
    const c = await serve(h);
    h.helper({ type: 'stopAll' });
    c.close();
    await flush();
    expect(h.toHelper.at(-1)).toMatchObject({ type: 'stopResult', ok: false });
    expect(h.relay.stopSignal.aborted).toBe(false);
  });

  it('serving: a throwing channel send fails the stop instead of throwing', async () => {
    const h = harness();
    const c = await serve(h);
    c.ch.send = () => {
      throw new Error('channel closed');
    };
    expect(() => h.helper({ type: 'stopAll' })).not.toThrow();
    expect(h.toHelper.at(-1)).toMatchObject({ type: 'stopResult', ok: false });
  });

  it('spawning: waits for ready, then stops over IPC', async () => {
    const h = harness();
    const first = await serve(h);
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'spawning' });
    const c = fakeChannel();
    h.relay.attachServer(c.ch);
    h.helper({ type: 'stopAll' });
    expect(c.sent).toEqual([]);
    expect(first.sent).toEqual([]);
    await h.advance(5_000);
    c.emit({ type: 'ready' });
    expect(c.sent).toEqual([{ type: 'stopAll', id: 1 }]);
    expect(h.relay.stopSignal.aborted).toBe(false);
  });

  it('spawning: no ready within 10 s → fails with the starting message, signal stays clear (W2)', async () => {
    const h = harness();
    await serve(h);
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.attachServer(fakeChannel().ch);
    h.helper({ type: 'stopAll' });
    await h.advance(10_000);
    const last = h.toHelper.at(-1);
    expect(last?.type === 'stopResult' && !last.ok && last.body).toMatch(
      /The background service is starting\. Try again in a moment\./,
    );
    expect(h.relay.stopSignal.aborted).toBe(false);
  });

  it('spawning: the child exiting first goes to the abort path', async () => {
    const h = harness();
    await serve(h);
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.attachServer(fakeChannel().ch);
    h.helper({ type: 'stopAll' });
    h.relay.hooks.childExit(1);
    expect(h.relay.stopSignal.aborted).toBe(true);
    await h.advance(10_000);
    expect(h.types()).not.toContain('stopResult');
  });

  it('no ready server: aborts stopSignal, shows stopping; finish(trayStop ok) → stopResult ok then exit', async () => {
    const h = harness({ pollResults: [2] });
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'restarting' });
    await flush();
    h.helper({ type: 'stopAll' });
    expect(h.relay.stopSignal.aborted).toBe(true);
    expect(h.views().at(-1)?.phase).toEqual({ phase: 'stopping' });
    const done = h.relay.finish({ reason: 'trayStop', ok: true, killed: 2 });
    await flush();
    expect(h.types().slice(-2)).toEqual(['stopResult', 'exit']);
    expect(h.toHelper.at(-2)).toEqual({ type: 'stopResult', ok: true });
    h.exitHelper(0);
    await done;
  });

  it('a failed tray stop → stopResult ok:false, exit, and a 60 s wait for the helper (P4)', async () => {
    const h = harness();
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'exhausted', retryAt: '12:30' });
    await flush();
    h.helper({ type: 'stopAll' });
    let finished = false;
    void h.relay.finish({ reason: 'trayStop', ok: false, error: 'hc refused' }).then(() => {
      finished = true;
    });
    await flush();
    const result = h.toHelper.at(-2);
    expect(result?.type === 'stopResult' && !result.ok && result.body).toMatch(/hc refused/);
    expect(h.toHelper.at(-1)).toEqual({ type: 'exit' });
    await h.advance(2_000);
    expect(finished).toBe(false);
    await h.advance(58_000);
    expect(finished).toBe(true);
  });

  it('W3: done after an abort still reports the stop as ok', async () => {
    const h = harness();
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.hooks.childExit(1);
    h.relay.hooks.phase({ phase: 'restarting' });
    await flush();
    h.helper({ type: 'stopAll' });
    void h.relay.finish({ reason: 'doneCoreIdle' });
    await flush();
    expect(h.toHelper.slice(-2)).toEqual([{ type: 'stopResult', ok: true }, { type: 'exit' }]);
  });

  it('finish(done) without a tray stop sends exit only and waits ≤ 2 s', async () => {
    const h = harness();
    await serve(h);
    let finished = false;
    void h.relay.finish({ reason: 'done' }).then(() => {
      finished = true;
    });
    await flush();
    expect(h.types().at(-1)).toBe('exit');
    expect(h.types()).not.toContain('stopResult');
    await h.advance(1_999);
    expect(finished).toBe(false);
    await h.advance(1);
    expect(finished).toBe(true);
  });

  it('finish resolves as soon as the helper exits', async () => {
    const h = harness();
    await serve(h);
    const done = h.relay.finish({ reason: 'done' });
    h.exitHelper(0);
    await done;
  });

  it('finish waits for a helper start still in flight', async () => {
    let release: () => void = () => {};
    const sent: SupervisorToHelper[] = [];
    const h = harness({
      launcher: {
        start: () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                send: (m) => {
                  sent.push(m);
                },
                exited: Promise.resolve(0),
                pid: 1,
              });
          }),
      },
    });
    h.relay.hooks.phase({ phase: 'spawning' });
    h.relay.hooks.childExit(1);
    const exit: SuperviseExit = { reason: 'done' };
    const done = h.relay.finish(exit);
    release();
    await done;
    expect(sent.map((m) => m.type)).toEqual(['init', 'view', 'exit']);
  });

  it('the IPC ok path reports at answer time; finish(doneCoreIdle) then sends exit only', async () => {
    const h = harness();
    const c = await serve(h);
    h.helper({ type: 'stopAll' });
    c.emit({ type: 'stopAllResult', id: 1, ok: true, killed: 1 });
    void h.relay.finish({ reason: 'doneCoreIdle' });
    await flush();
    expect(h.types().filter((t) => t === 'stopResult')).toHaveLength(1);
    expect(h.types().at(-1)).toBe('exit');
  });
});

describe('createTrayRelay — seam', () => {
  it('mirrors every message both ways and routes an injected stopAll without a confirm', async () => {
    const mirrored: { dir: string; m: object }[] = [];
    let inject: (m: HelperToSupervisor) => void = () => {};
    const h = harness({
      seam: {
        mirror: (dir, m) => mirrored.push({ dir, m }),
        injected: (cb) => {
          inject = cb;
          return () => {};
        },
      },
    });
    const c = await serve(h);
    h.helper({ type: 'shown' });
    inject({ type: 'stopAll' });
    expect(c.sent).toEqual([{ type: 'stopAll', id: 1 }]);
    expect(mirrored.filter((x) => x.dir === 'out').map((x) => x.m)).toEqual(h.toHelper);
    expect(mirrored.filter((x) => x.dir === 'in').map((x) => x.m)).toEqual([
      { type: 'shown' },
      { type: 'stopAll' },
    ]);
  });

  it('a throwing seam mirror is logged and the message still goes out', async () => {
    const h = harness({
      seam: {
        mirror: () => {
          throw new Error('disk full');
        },
        injected: () => () => {},
      },
    });
    await serve(h);
    expect(h.types()).toContain('init');
    expect(h.logs.some((l) => /disk full/.test(l.message))).toBe(true);
  });
});
