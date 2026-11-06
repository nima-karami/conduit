import * as fs from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerAttention } from '../../server/attention';
import { compose } from '../../server/compose';
import { createServices, type Services, type ServicesOptions } from '../../server/services';
import { type Peer, PipeTransport, type RpcAnswer } from '../../server/transport/pipe';
import type { ServerEvent, ServerEvents, SessionView } from '../../src/contracts/server-protocol';
import type { InstanceNames } from '../../src/contracts/session-identity';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';
import { instanceNames } from '../../src/instance-names';
import type { AgentDefinition } from '../../src/types';
import { onLines, writeJsonLine } from '../helpers/line-socket';
import { allowPeerReset } from '../helpers/peer-socket';
import { testEndpoint } from '../helpers/test-endpoint';

const SHELL: AgentDefinition = {
  id: 'test-shell',
  label: 'Shell',
  command: 'sh',
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
};
const noLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
type Sent = { type: ServerEvent; data: unknown; peer?: object };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

async function harness(options: Partial<ServicesOptions> = {}, userDataOf?: string) {
  const fake = new FakeHc();
  await fake.listen();
  const hc = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10, log: () => {} });
  const userData = userDataOf ?? fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
  const names: InstanceNames = {
    ...instanceNames(userData, process.platform === 'win32' ? 'win32' : 'posix', os.tmpdir(), {
      home: '/home/conduit-test',
      uid: 1000,
      runtimeDir: '',
    }),
    mcpEndpoint: testEndpoint(),
  };
  const sent: Sent[] = [];
  const health: unknown[] = [];
  const startCore = vi.fn(async () => {});
  const services = createServices({
    userData,
    names,
    platform: process.platform,
    e2e: true,
    appVersion: '9.9.9',
    logPath: path.join(userData, 'server.log'),
    env: {},
    homeDir: userData,
    hc,
    startCore,
    shim: { execPath: process.execPath, shimPath: path.join(userData, 'shim.cjs') },
    emit: (type, data) => sent.push({ type, data }),
    emitTo: (peer, type, data) => sent.push({ type, data, peer }),
    stopping: () => false,
    onHealth: (h) => health.push(h),
    log: noLog,
    detectShells: () => [SHELL],
    detectClis: () => [],
    resolveCommand: (c) => c,
    ...options,
  });
  cleanups.push(async () => {
    await services.close();
    await fake.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  return { fake, services, sent, health, startCore, userData, names };
}

const of = <E extends ServerEvent>(sent: Sent[], type: E) =>
  sent.filter((s) => s.type === type).map((s) => s.data as ServerEvents[E]);

async function answer(
  services: Services,
  method: string,
  params: unknown,
  peer: Peer = { subscribed: true },
) {
  const a: RpcAnswer = await services.dispatch({ id: 1, method, params }, peer);
  return a;
}

describe('compose: startup order (F1.4)', () => {
  it('keeps the server available to report an endpoint configuration failure', async () => {
    const h = await harness();
    h.names.hcEndpointError = 'Malformed hc socket configuration';
    expect(await h.services.core.start()).toEqual({
      state: 'unavailable',
      reason: 'Malformed hc socket configuration',
      logPath: path.join(h.userData, 'server.log'),
    });
    expect(h.startCore).not.toHaveBeenCalled();
  });
  it('runs the packaged install pass once, persists its gate result, and reuses it after restart', async () => {
    const previousShims = [
      { execPath: '/install/Conduit.exe', shimPath: '/install/resources/shim.cjs' },
    ];
    const h = await harness({ packaged: true, e2e: false, previousShims });
    const startup = vi.spyOn(h.services.mcp, 'installStartup').mockReturnValue({
      gateMigrated: true,
      rows: [],
    });
    const adopted = vi.spyOn(h.services.domain, 'adopted');
    await h.services.core.start();
    await h.services.core.start();
    expect(startup).toHaveBeenCalledExactlyOnceWith({
      previous: previousShims,
      gateMigrated: false,
    });
    expect(startup.mock.invocationCallOrder[0]).toBeLessThan(adopted.mock.invocationCallOrder[0]);
    expect(h.services.domain.settings().mcpGateMigrated).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(h.userData, 'server-settings.json'), 'utf8')),
    ).toMatchObject({ version: 1, settings: { mcpGateMigrated: true } });

    await h.services.close();
    const next = await harness({ packaged: true, e2e: false, previousShims }, h.userData);
    const nextStartup = vi.spyOn(next.services.mcp, 'installStartup').mockReturnValue({
      gateMigrated: true,
      rows: [],
    });
    await next.services.core.start();
    expect(nextStartup).toHaveBeenCalledExactlyOnceWith({
      previous: previousShims,
      gateMigrated: true,
    });
  });

  it.each([
    { packaged: false, e2e: false },
    { packaged: true, e2e: true },
  ])('skips startup install for $packaged packaged / $e2e e2e', async (options) => {
    const h = await harness(options);
    const startup = vi.spyOn(h.services.mcp, 'installStartup');
    await h.services.core.start();
    expect(startup).not.toHaveBeenCalled();
  });

  it('subscribes, reconciles, adopts, then starts MCP, and only then reports health', async () => {
    const h = await harness();
    const order: string[] = [];
    const { runtime, domain, mcp } = h.services;
    const sub = runtime.subscribe.bind(runtime);
    vi.spyOn(runtime, 'subscribe').mockImplementation(async () => {
      order.push('subscribe');
      await sub();
    });
    const rec = runtime.reconcile.bind(runtime);
    vi.spyOn(runtime, 'reconcile').mockImplementation(async () => {
      order.push('reconcile');
      return rec();
    });
    const adopted = domain.adopted;
    domain.adopted = (t) => {
      order.push('adopted');
      adopted(t);
    };
    const start = mcp.start;
    mcp.start = async () => {
      order.push('mcp.start');
      expect(h.health).toEqual([]);
      await start();
    };
    const result = await h.services.core.start();
    expect(order).toEqual(['subscribe', 'reconcile', 'adopted', 'mcp.start']);
    expect(result.state).toBe('ready');
    // A second start (the shell's retry after a later failure) never re-adopts or re-listens.
    await h.services.core.start();
    expect(order).toHaveLength(4);
  });

  it('a failed reconcile still ends the cold-start wait with adopted([])', async () => {
    const h = await harness();
    vi.spyOn(h.services.runtime, 'reconcile').mockRejectedValue(new Error('boom'));
    const adopted = vi.spyOn(h.services.domain, 'adopted');
    await h.services.core.start();
    expect(adopted).toHaveBeenCalledWith([]);
  });

  it('an unreachable core is started, and the start rejects so the shell retries', async () => {
    const h = await harness();
    await h.fake.close();
    await expect(h.services.core.start()).rejects.toThrow();
    expect(h.startCore).toHaveBeenCalled();
  });
});

describe('compose: sessions.changed carries attention', () => {
  it('merges statusOf into every sessions.changed and the snapshot, and re-sends on a change', async () => {
    // Registered while the services are built, so the listener is caught on the prototype.
    const onChange = vi.spyOn(ServerAttention.prototype, 'onChange');
    const h = await harness();
    await h.services.core.start();
    const created = await answer(h.services, 'sessions.create', {
      agentId: SHELL.id,
      home: h.userData,
    });
    expect(created).toHaveProperty('result.sessionId');
    const id = 'result' in created ? (created.result as { sessionId: string }).sessionId : '';
    vi.spyOn(h.services.attention, 'statusOf').mockReturnValue({
      busy: true,
      needsAttention: true,
      completedRun: false,
      attentionReason: 'blocked',
      completions: 3,
    });
    await vi.waitFor(() =>
      expect(
        of(h.sent, 'sessions.changed')
          .at(-1)
          ?.sessions.some((s) => s.id === id),
      ).toBe(true),
    );
    const last = (): SessionView | undefined =>
      of(h.sent, 'sessions.changed')
        .at(-1)
        ?.sessions.find((s) => s.id === id);
    expect(last()).toMatchObject({
      busy: true,
      needsAttention: true,
      attentionReason: 'blocked',
      completions: 3,
    });
    expect(h.services.core.snapshot().sessions.find((s) => s.id === id)).toMatchObject({
      busy: true,
      attentionReason: 'blocked',
      completions: 3,
    });
    // The domain's neutral pre-decoration facts never reach the wire in place of the producer's.
    expect(h.services.domain.snapshot().sessions.find((s) => s.id === id)).toMatchObject({
      attentionReason: null,
      completions: 0,
    });
    const before = of(h.sent, 'sessions.changed').length;
    const changed = onChange.mock.calls[0]?.[0];
    expect(changed).toBeDefined();
    changed?.();
    changed?.();
    // Coalesced: two flips within the window are one re-send.
    await vi.waitFor(() => expect(of(h.sent, 'sessions.changed').length).toBe(before + 1));
  });

  it('a counter-only change re-sends, and the coalesced event carries the final count', async () => {
    const onChange = vi.spyOn(ServerAttention.prototype, 'onChange');
    const h = await harness();
    await h.services.core.start();
    const created = await answer(h.services, 'sessions.create', {
      agentId: SHELL.id,
      home: h.userData,
    });
    const id = 'result' in created ? (created.result as { sessionId: string }).sessionId : '';
    const status = vi.spyOn(h.services.attention, 'statusOf');
    const facts = (completions: number) => ({
      busy: false,
      needsAttention: false,
      completedRun: true,
      attentionReason: null,
      completions,
    });
    await vi.waitFor(() => expect(of(h.sent, 'sessions.changed').length).toBeGreaterThan(0));
    const before = of(h.sent, 'sessions.changed').length;
    const changed = onChange.mock.calls[0]?.[0];
    status.mockReturnValue(facts(1));
    changed?.();
    status.mockReturnValue(facts(2));
    changed?.();
    await vi.waitFor(() => expect(of(h.sent, 'sessions.changed').length).toBe(before + 1));
    expect(
      of(h.sent, 'sessions.changed')
        .at(-1)
        ?.sessions.find((s) => s.id === id),
    ).toMatchObject({ completions: 2 });
  });
});

describe('compose: dispatch routing', () => {
  it('routes term, ui and mcp traffic to the right service, and refuses the rest', async () => {
    const h = await harness();
    const { runtime, domain, mcp } = h.services;
    const peer: Peer = { subscribed: true };
    const termInput = vi.spyOn(mcp, 'termInput');
    await answer(h.services, 'term.input', { sessionId: 's', generation: 1, data: 'x' }, peer);
    expect(termInput).toHaveBeenCalledWith({ sessionId: 's', generation: 1, data: 'x' });

    const resize = vi.spyOn(runtime, 'resize');
    const resized = vi.spyOn(domain, 'resized');
    await answer(h.services, 'term.resize', { sessionId: 's', cols: 80, rows: 24 });
    expect(resize).toHaveBeenCalledWith('s', { cols: 80, rows: 24 });
    expect(resized).toHaveBeenCalledWith('s', { cols: 80, rows: 24 });

    const facts = vi.spyOn(runtime, 'facts');
    await answer(h.services, 'term.facts', { sessionId: 's', facts: { fg: '#fff' } });
    expect(facts).toHaveBeenCalledWith('s', { fg: '#fff' });

    const windows = [
      { windowId: 1, focused: true, ready: true, visibleSessionIds: [], ownedSessionIds: [] },
    ];
    const domainPresence = vi.spyOn(domain, 'presence');
    const mcpPresence = vi.spyOn(mcp, 'presence');
    await answer(h.services, 'ui.presence', { windows }, peer);
    expect(domainPresence).toHaveBeenCalledWith(windows);
    expect(mcpPresence).toHaveBeenCalledWith(peer, windows);

    const reload = vi.spyOn(domain, 'reloadAgents');
    h.services.connected();
    expect(reload).toHaveBeenCalledOnce();

    const appDisconnected = vi.spyOn(mcp, 'appDisconnected');
    h.services.disconnected(peer);
    expect(appDisconnected).toHaveBeenCalledWith(peer);

    expect(await answer(h.services, 'sessions.reorder', { order: [] })).toHaveProperty('result');
    await expect(answer(h.services, 'nope', {})).rejects.toMatchObject({ code: -32601 });
    await expect(
      answer(h.services, 'term.resize', { sessionId: 's', cols: 'x' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('compose: persist and stop reach every service', () => {
  it('persist, beginStopping, killSessions, idleState and close', async () => {
    const h = await harness();
    await h.services.core.start();
    const { runtime, domain, mcp, scrollback, attention } = h.services;
    const persist = vi.spyOn(domain, 'persist');
    const flush = vi.spyOn(scrollback, 'flushPending');
    await h.services.core.persist();
    expect(persist).toHaveBeenCalled();
    expect(flush).toHaveBeenCalled();

    const begin = vi.spyOn(runtime, 'beginStopping');
    await h.services.core.beginStopping('stopAll');
    expect(begin).toHaveBeenCalledWith('stopAll');
    const kill = vi.spyOn(runtime, 'killSessions');
    await h.services.core.killSessions();
    expect(kill).toHaveBeenCalled();

    expect(await h.services.core.idleState()).toEqual({
      liveTerminals: 1,
      pendingTimers: false,
      busyTokens: false,
    });

    const stop = vi.spyOn(mcp, 'stop');
    const dispose = vi.spyOn(domain, 'dispose');
    const attentionDispose = vi.spyOn(attention, 'dispose');
    const close = vi.spyOn(runtime, 'close');
    await Promise.all([h.services.close(), h.services.close()]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(attentionDispose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('compose: per-peer events', () => {
  function client(endpoint: string) {
    const lines: Array<{ method?: string; params?: { type: string } }> = [];
    const socket: Socket = allowPeerReset(createConnection(endpoint));
    onLines(socket, (line) => lines.push(JSON.parse(line)));
    const send = (id: number, method: string, params: unknown = {}) =>
      writeJsonLine(socket, { jsonrpc: '2.0', id, method, params });
    return { socket, lines, send };
  }

  it('emitTo reaches only that subscribed peer, and compose hands the peer to disconnected', async () => {
    const transport = new PipeTransport(
      testEndpoint(),
      process.platform === 'win32' ? 'win32' : 'posix',
    );
    const peers: Peer[] = [];
    const gone: Peer[] = [];
    const joined: Peer[] = [];
    const shell = compose({
      transport,
      core: {
        start: async () => ({ state: 'ready', hcVersion: '0.1.16' }),
        beginStopping: async () => {},
        killSessions: async () => 0,
        persist: async () => {},
        idleState: async () => ({ liveTerminals: 1, pendingTimers: false, busyTokens: false }),
        snapshot: () => ({
          sessions: [],
          settings: {} as never,
          stores: { agents: [], launchers: [], projects: [] },
          timers: { schedules: [], offer: null },
          mcp: {} as never,
          pendingAsks: [],
        }),
      },
      version: '9.9.9',
      instance: 'i',
      logPath: 'server.log',
      exit: () => {},
      dispatch: async (_r, peer) => {
        peers.push(peer);
        return { result: {} };
      },
      connected: (peer) => joined.push(peer),
      disconnected: (peer) => gone.push(peer),
    });
    await transport.listen(shell.handle);
    cleanups.push(async () => {
      shell.lifecycle.dispose();
      await transport.close();
    });
    const a = client(transport.endpoint);
    const b = client(transport.endpoint);
    for (const c of [a, b]) {
      c.send(1, 'hello', { appVersion: '9.9.9', generation: 1 });
      c.send(2, 'events.subscribe');
      c.send(3, 'ping');
    }
    await vi.waitFor(() => expect(peers).toHaveLength(2));
    expect(joined).toHaveLength(2);
    transport.emitTo(peers[0], 'attention.flash', { sessionId: 's' });
    transport.emit('attention.flash', { sessionId: 'all' });
    await vi.waitFor(() => expect(b.lines.filter((l) => l.method === 'event')).toHaveLength(1));
    const events = (c: typeof a) =>
      c.lines.filter((l) => l.method === 'event').map((l) => l.params);
    await vi.waitFor(() => expect(events(a).length + events(b).length).toBe(3));
    const aGot = events(a).map(
      (e) => (e as unknown as { data: { sessionId: string } }).data.sessionId,
    );
    const bGot = events(b).map(
      (e) => (e as unknown as { data: { sessionId: string } }).data.sessionId,
    );
    // Which socket became peers[0] is arrival order, so check the split, not the names.
    expect([aGot, bGot].sort((x, y) => x.length - y.length)).toEqual([['all'], ['s', 'all']]);
    a.socket.destroy();
    await vi.waitFor(() => expect(gone).toHaveLength(1));
    expect(peers).toContain(gone[0]);
  });
});
