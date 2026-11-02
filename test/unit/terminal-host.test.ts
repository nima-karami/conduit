import { describe, expect, it } from 'vitest';
import { createTerminalHost } from '../../electron/terminal-host';
import type { AppSessionView, ServerMethods } from '../../src/contracts/server-protocol';
import {
  APP_ATTACH_HISTORY_LINES,
  type TerminalLinkEvents,
  type TerminalLinkFactory,
} from '../../src/contracts/terminal-link';
import type { HostToWebview } from '../../src/protocol';

type StartResult = ServerMethods['sessions.start']['result'];
const TARGET = { hcSession: 'conduit-abc', terminal: 't1' };
const START = { type: 'term:start', sessionId: 's1', cols: 80, rows: 24 } as const;
const paint = (data: string) => ({ data, replay: [{ length: data.length }] });

const view = (over: Partial<AppSessionView> = {}): AppSessionView => ({
  id: 's1',
  name: 's1',
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  runtime: { generation: 1, spawn: 'live', reportedStatus: null, lastSize: null },
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(results: StartResult[], opts: { connected?: boolean; firstPaint?: string } = {}) {
  const trace: string[] = [];
  const sent: HostToWebview[] = [];
  const attaches: { history: number; events: TerminalLinkEvents; closed: boolean }[] = [];
  let connected = opts.connected ?? true;
  let views: AppSessionView[] = [view()];
  const client = {
    call: async (m: string) => {
      trace.push(`call:${m}`);
      const r = results.shift();
      if (!r) throw new Error('no scripted result');
      return r;
    },
    notify: (n: string, p: unknown) => {
      trace.push(`notify:${n}`);
      if (n === 'term.input') trace.push(JSON.stringify(p));
      return true;
    },
  };
  const links: TerminalLinkFactory = {
    attach: async (sessionId, _target, _size, history, events) => {
      trace.push(`attach:${history}`);
      const a = { history, events, closed: false };
      attaches.push(a);
      return {
        sessionId,
        firstPaint: paint(opts.firstPaint ?? 'SCREEN'),
        close: () => {
          a.closed = true;
        },
      };
    },
  };
  const host = createTerminalHost({
    client: () => (connected ? (client as never) : null),
    links,
    store: {
      get: (id) => views.find((v) => v.id === id),
      generationOf: (id) => views.find((v) => v.id === id)?.runtime.generation ?? null,
    },
    sendToOwner: (_id, m) => {
      sent.push(m);
      if (m.type === 'term:data') trace.push(`data:${m.data}${m.replay ? ':replay' : ''}`);
      if (m.type === 'term:exit') trace.push(`exit:${m.code}`);
    },
    log: () => {},
  });
  return {
    host,
    trace,
    sent,
    attaches,
    setViews: (v: AppSessionView[]) => {
      const prev = views;
      views = v;
      return prev;
    },
    setConnected: (v: boolean) => {
      connected = v;
    },
  };
}

const live = (over: Partial<Extract<StartResult, { target: unknown }>> = {}): StartResult => ({
  ok: true,
  target: TARGET,
  generation: 1,
  spawned: false,
  ...over,
});

describe('terminal-host', () => {
  it('resize and facts are sent before sessions.start', async () => {
    const r = rig([live()]);
    r.host.facts('s1', { fg: '#fff', bg: '#000' });
    r.trace.length = 0;
    await r.host.start(START);
    expect(r.trace.slice(0, 3)).toEqual([
      'notify:term.resize',
      'notify:term.facts',
      'call:sessions.start',
    ]);
  });

  it('spawned:false attaches with no prelude', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    expect(r.trace).toEqual([
      'notify:term.resize',
      'call:sessions.start',
      `attach:${APP_ATTACH_HISTORY_LINES}`,
      'data:SCREEN:replay',
    ]);
  });

  it('retryLaunch on a mounted pane takes the start path with sessions.retryLaunch', async () => {
    const r = rig([{ ok: false, refusal: { reason: 'home-missing' } }, live()]);
    await r.host.start(START);
    r.trace.length = 0;
    await r.host.retryLaunch('s1');
    expect(r.trace).toEqual([
      'notify:term.resize',
      'call:sessions.retryLaunch',
      `attach:${APP_ATTACH_HISTORY_LINES}`,
      'data:SCREEN:replay',
    ]);
  });

  it('retryLaunch with no pane only asks the server', async () => {
    const r = rig([live()]);
    await r.host.retryLaunch('s1');
    expect(r.trace).toEqual(['call:sessions.retryLaunch']);
  });

  it('cold start writes term.show then prelude as term:data{replay} then attaches', async () => {
    const r = rig([live({ spawned: true, prelude: paint('HISTORY') })], { firstPaint: '' });
    const started = r.host.start(START);
    // The server's can't-start/banner bytes arrive as term.show before the start reply.
    r.host.show('s1', 'BANNER');
    await started;
    expect(r.trace.filter((t) => !t.startsWith('notify'))).toEqual([
      'call:sessions.start',
      'data:BANNER',
      'data:HISTORY:replay',
      `attach:${APP_ATTACH_HISTORY_LINES}`,
    ]);
  });

  it('finished writes prelude, emits term:exit, attaches nothing', async () => {
    const r = rig([
      {
        ok: true,
        finished: { exitCode: 7, reason: 'exited', output: 'bye' },
        prelude: paint('bye'),
      },
    ]);
    await r.host.start(START);
    expect(r.trace.filter((t) => !t.startsWith('notify'))).toEqual([
      'call:sessions.start',
      'data:bye:replay',
      'exit:7',
    ]);
    expect(r.attaches).toHaveLength(0);
  });

  it('refusal writes prelude only', async () => {
    const r = rig([{ ok: false, refusal: { reason: 'home-missing' }, prelude: paint('OLD') }]);
    await r.host.start(START);
    expect(r.trace.filter((t) => !t.startsWith('notify'))).toEqual([
      'call:sessions.start',
      'data:OLD:replay',
    ]);
    expect(r.attaches).toHaveLength(0);
  });

  it('link CLOSE does not change state', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    r.trace.length = 0;
    r.attaches[0].events.closed('exited', 3, false);
    await flush();
    // A later list that still says running/live (status lags the CLOSE) re-attaches nothing.
    const prev = r.setViews([view({ busy: true })]);
    r.host.sessionsChanged(prev, [view({ busy: true })]);
    await flush();
    expect(r.trace).toEqual([]);
    expect(r.sent.filter((m) => m.type === 'term:exit')).toHaveLength(0);
  });

  it('running→exited emits term:exit with cached code', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    const exited = view({ status: 'exited', exitCode: 2 });
    const prev = r.setViews([exited]);
    r.host.sessionsChanged(prev, [exited]);
    expect(r.trace.at(-1)).toBe('exit:2');
    // Only on the transition.
    r.host.sessionsChanged([exited], [exited]);
    expect(r.sent.filter((m) => m.type === 'term:exit')).toHaveLength(1);
  });

  it('running→exited with no code emits the process exited line', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    const exited = view({ status: 'exited', exitCode: null });
    const prev = r.setViews([exited]);
    r.host.sessionsChanged(prev, [exited]);
    expect(r.sent).toContainEqual({
      type: 'term:data',
      sessionId: 's1',
      data: '\r\n\x1b[2m[process exited]\x1b[0m\r\n',
    });
    expect(r.sent.filter((m) => m.type === 'term:exit')).toHaveLength(0);
  });

  it('input dropped while client null', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    r.setConnected(false);
    r.trace.length = 0;
    r.host.input('s1', 'x');
    expect(r.trace).toEqual([]);
    r.setConnected(true);
    r.host.input('s1', 'y');
    expect(r.trace).toEqual([
      'notify:term.input',
      JSON.stringify({ sessionId: 's1', generation: 1, data: 'y' }),
    ]);
  });

  it('input with no generation is dropped', () => {
    const r = rig([]);
    r.setViews([
      view({ runtime: { generation: null, spawn: 'none', reportedStatus: null, lastSize: null } }),
    ]);
    r.host.input('s1', 'x');
    expect(r.trace).toEqual([]);
  });

  it('relaunched live session with mounted pane re-attaches', async () => {
    const stale = view({
      status: 'stale',
      runtime: { generation: null, spawn: 'none', reportedStatus: null, lastSize: null },
    });
    const r = rig([{ ok: false, refusal: { reason: 'home-missing' } }, live({ generation: 2 })]);
    r.setViews([stale]);
    await r.host.start(START);
    expect(r.attaches).toHaveLength(0);
    const relaunched = view({
      runtime: { generation: 2, spawn: 'live', reportedStatus: null, lastSize: null },
    });
    const prev = r.setViews([relaunched]);
    r.host.sessionsChanged(prev, [relaunched]);
    await flush();
    expect(r.trace.filter((t) => t.startsWith('call') || t.startsWith('attach'))).toEqual([
      'call:sessions.start',
      'call:sessions.start',
      `attach:${APP_ATTACH_HISTORY_LINES}`,
    ]);
  });

  it('restartSeq bump closes the link and attaches nothing until the remount', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    const bumped = view({ restartSeq: 1 });
    const prev = r.setViews([bumped]);
    r.host.sessionsChanged(prev, [bumped]);
    await flush();
    expect(r.attaches[0].closed).toBe(true);
    expect(r.attaches).toHaveLength(1);
  });

  it('hc reconnect re-attaches with history 0', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    r.attaches[0].events.closed('disconnected', null, true);
    await flush();
    r.host.hcReconnected();
    await flush();
    expect(r.attaches.map((a) => a.history)).toEqual([APP_ATTACH_HISTORY_LINES, 0]);
  });

  it('hc reconnect does not reattach a generation that already ended', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    r.attaches[0].events.closed('exited', null, false);
    await flush();
    r.host.hcReconnected();
    await flush();
    expect(r.attaches).toHaveLength(1);
  });

  it('server reconnect does not restart a generation that already ended', async () => {
    const r = rig([live()]);
    await r.host.start(START);
    r.attaches[0].events.closed('exited', null, false);
    await flush();
    r.setConnected(false);
    r.setConnected(true);
    r.host.serverConnected();
    await flush();
    expect(r.trace.filter((entry) => entry === 'call:sessions.start')).toHaveLength(1);
    expect(r.attaches).toHaveLength(1);
  });

  it('a start while down runs on serverConnected', async () => {
    const r = rig([live()], { connected: false });
    await r.host.start(START);
    expect(r.trace).toEqual([]);
    r.setConnected(true);
    r.host.serverConnected();
    await flush();
    expect(r.attaches).toHaveLength(1);
  });
});
