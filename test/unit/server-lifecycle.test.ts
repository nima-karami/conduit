import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HcCliDeps } from '../../electron/hc-cli';
import { createHcEvents } from '../../electron/hc-events';
import { ServerClient } from '../../electron/server-client';
import {
  createServerLifecycle,
  type ServerLifecycleState,
  VANISHED_RESTART_BUDGET,
} from '../../electron/server-lifecycle';
import type { HcTerminal } from '../../src/contracts/hc';
import { SERVER_RESTART_EXIT_WAIT_MS } from '../../src/contracts/server-protocol';
import type { InstanceNames } from '../../src/contracts/session-identity';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';
import { FakeC2Server } from './fake-c2-server';

const APP_VERSION = '0.52.0';
const SUPERVISOR = 'conduit-server-abc';
const INSTANCE = { 'conduit.instance': 'abc' };

type Harness = Awaited<ReturnType<typeof harness>>;
let open: Harness | undefined;

afterEach(async () => {
  vi.useRealTimers();
  if (!open) return;
  open.lifecycle.dispose();
  open.hcEvents.close();
  open.real.close();
  await open.fake.close();
  await open.c2.close();
  open = undefined;
});

/** Polls on setImmediate: vi.waitFor advances fake timers. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 20_000 && !check(); i++) await new Promise((r) => setImmediate(r));
  if (!check()) throw new Error(`never: ${what}`);
}

async function harness(
  o: { supervisorLive?: boolean; marker?: boolean; serverVersion?: string } = {},
) {
  const fake = new FakeHc();
  await fake.listen();
  const c2 = new FakeC2Server();
  await c2.listen();
  const real = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10 });
  const hcEvents = createHcEvents(real, INSTANCE, () => {});
  await hcEvents.ready();

  const flags = { marker: o.marker ?? false, serverVersion: o.serverVersion ?? APP_VERSION };
  let nextSupervisor = 100;
  const addSupervisor = (name = SUPERVISOR, labels: Record<string, string> = {}) => {
    const t: HcTerminal = {
      address: `t${nextSupervisor++}`,
      name,
      labels: { 'conduit.role': 'server', ...INSTANCE, ...labels },
      argv: ['node', 'supervise.js'],
      cwd: '/',
      state: 'live',
      created_ms: 0,
      screen: 'exact',
      cols: 80,
      rows: 24,
    };
    fake.terminals.push(t);
    fake.emit(t, 'created', t);
    return t;
  };
  const supervisor = () => fake.terminals.find((t) => t.name === SUPERVISOR && t.state === 'live');
  /** The supervisor ends on its own; the server with it. */
  const killSupervisorTerminal = async () => {
    const t = supervisor();
    if (t) await real.call('terminal.kill', { terminal: t.address });
  };
  if (o.supervisorLive) addSupervisor();

  c2.on('hello', () => {
    const t = supervisor();
    return {
      serverVersion: flags.serverVersion,
      generation: 1,
      instance: 'abc',
      pid: 1,
      ...(t ? { supervisor: { name: SUPERVISOR, terminal: t.address } } : {}),
    };
  });

  const cliCalls: string[][] = [];
  const cliResult = { code: 0, stdout: '', stderr: '' };
  const cli: HcCliDeps = {
    hcExe: 'hc',
    env: { HC_SESSION: 'conduit-abc' },
    coreCwd: '/u/runtime/hc/0.1.16',
    execFile: async (_file, args) => {
      cliCalls.push(args);
      if (cliResult.code !== 0) return cliResult;
      if (args[0] === 'run') addSupervisor();
      if (args[0] === 'kill') await killSupervisorTerminal();
      return cliResult;
    },
  };
  const names: InstanceNames = {
    instance: 'abc',
    serverEndpoint: c2.endpoint,
    mcpEndpoint: '/u/mcp.sock',
    supervisorName: SUPERVISOR,
    hcSession: 'conduit-abc',
    runtimeRoot: '/u/runtime',
    hcConfigHome: '/u/hc/config',
    hcStateHome: '/u/hc/state',
  };
  const clock = { now: 1_000_000 };
  const spawned: number[] = [];
  let clients = 0;
  let settled = 0;
  const states: ServerLifecycleState[] = [];
  const lifecycle = createServerLifecycle({
    names,
    layout: {
      nodeExe: 'node',
      superviseJs: '/repo/out/server/supervise.js',
      hcExe: 'hc',
      hcVersion: '0.1.16',
      coreCwd: '/u/runtime/hc/0.1.16',
    },
    userData: '/u',
    appVersion: APP_VERSION,
    serverArgs: ['--e2e'],
    client: () => {
      clients++;
      const c = new ServerClient({ endpoint: c2.endpoint, appVersion: APP_VERSION, log: () => {} });
      const openIt = c.open.bind(c);
      c.open = () => {
        const opening = openIt();
        opening.then(
          () => settled++,
          () => settled++,
        );
        return opening;
      };
      return c;
    },
    hc: real,
    hcEvents,
    cli,
    markerExists: async () => flags.marker,
    deleteMarker: async () => {
      flags.marker = false;
    },
    spawnDetachedSupervisor: () => spawned.push(clock.now),
    now: () => clock.now,
    log: () => {},
  });
  lifecycle.onState((s) => states.push(s));
  const h = {
    fake,
    c2,
    real,
    hcEvents,
    lifecycle,
    flags,
    cliCalls,
    cliResult,
    clock,
    spawned,
    states,
    clients: () => clients,
    settled: () => settled,
    addSupervisor,
    supervisor,
    killSupervisorTerminal,
    state: () => lifecycle.current().state,
    runs: () => cliCalls.filter((a) => a[0] === 'run').length,
  };
  open = h;
  return h;
}

describe('createServerLifecycle start rule', () => {
  it('start rule: live conduit-server-<h> → connect only, no run', async () => {
    const h = await harness({ supervisorLive: true });
    await h.lifecycle.start();
    expect(h.state()).toBe('connected');
    expect(h.lifecycle.client()).not.toBeNull();
    expect(h.cliCalls).toEqual([]);
    expect(h.fake.calls.some((c) => c.method === 'terminal.run')).toBe(false);
    expect(h.fake.calls.find((c) => c.method === 'terminal.get')?.params).toEqual({
      terminal: SUPERVISOR,
    });
  });

  it('start rule: marker present → unavailable exhausted, no run', async () => {
    const h = await harness({ marker: true });
    await h.lifecycle.start();
    expect(h.lifecycle.current()).toEqual({
      state: 'unavailable',
      reason: 'exhausted',
      logPath: expect.stringContaining('server.log'),
    });
    expect(h.cliCalls).toEqual([]);
    expect(h.c2.calls('hello')).toEqual([]);
  });

  it('role label alone does not count as live', async () => {
    const h = await harness();
    h.addSupervisor('some-other-name');
    await h.lifecycle.start();
    expect(h.runs()).toBe(1);
    expect(h.state()).toBe('connected');
  });

  it('hc core unreachable → runs start (name_taken on run is treated as live)', async () => {
    const h = await harness();
    await h.fake.close();
    h.cliResult.code = 1;
    h.cliResult.stderr = 'error: a live terminal is already named conduit-server-abc (name_taken)';
    await h.lifecycle.start();
    expect(h.runs()).toBe(1);
    expect(h.spawned).toEqual([]);
    expect(h.state()).toBe('connected');
  });

  it('hc run failure → spawnDetachedSupervisor', async () => {
    const h = await harness();
    h.cliResult.code = 1;
    h.cliResult.stderr = 'error: spawn failed';
    await h.lifecycle.start();
    expect(h.spawned).toHaveLength(1);
    expect(h.state()).toBe('connected');
  });
});

describe('createServerLifecycle versions (F6, D26)', () => {
  it('appNewer → server.restart{update}, waits finished of hello.supervisor.terminal, then start rule', async () => {
    const h = await harness({ supervisorLive: true, serverVersion: '0.51.0' });
    const old = h.supervisor()?.address;
    h.c2.on('server.restart', () => {
      // The reply first, then the server and its supervisor exit (D32).
      setTimeout(() => {
        h.flags.serverVersion = APP_VERSION;
        h.c2.dropClients();
        void h.killSupervisorTerminal();
      }, 20);
      return {};
    });
    await h.lifecycle.start();
    expect(h.c2.calls('server.restart').map((r) => r.params)).toEqual([{ reason: 'update' }]);
    expect(h.runs()).toBe(1);
    const now = h.lifecycle.current();
    expect(now.state === 'connected' && now.hello.serverVersion).toBe(APP_VERSION);
    expect(now.state === 'connected' && now.hello.supervisor?.terminal).not.toBe(old);
  });

  it('restart wait past SERVER_RESTART_EXIT_WAIT_MS → unavailable restart-wait-timeout', async () => {
    const h = await harness({ supervisorLive: true, serverVersion: '0.51.0' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = h.lifecycle.start();
    await until(() => h.c2.calls('server.restart').length === 1, 'server.restart');
    await until(() => h.fake.calls.filter((c) => c.method === 'terminal.get').length >= 2, 'check');
    vi.advanceTimersByTime(SERVER_RESTART_EXIT_WAIT_MS - 1);
    await new Promise((r) => setImmediate(r));
    expect(h.state()).toBe('connecting');
    vi.advanceTimersByTime(1);
    await started;
    expect(h.lifecycle.current()).toMatchObject({
      state: 'unavailable',
      reason: 'restart-wait-timeout',
    });
    expect(h.runs()).toBe(0);
  });

  it('appOlder → downgrade, no restart', async () => {
    const h = await harness({ supervisorLive: true, serverVersion: '0.53.0' });
    await h.lifecycle.start();
    expect(h.lifecycle.current()).toEqual({ state: 'downgrade', serverVersion: '0.53.0' });
    expect(h.lifecycle.client()).toBeNull();
    expect(h.c2.calls('server.restart')).toEqual([]);
  });

  it('stopAllAndContinue → server.stopAll, wait finished, start rule', async () => {
    const h = await harness({ supervisorLive: true, serverVersion: '0.53.0' });
    await h.lifecycle.start();
    h.c2.on('server.stopAll', () => {
      setTimeout(() => {
        h.flags.serverVersion = APP_VERSION;
        h.c2.dropClients();
        void h.killSupervisorTerminal();
      }, 20);
      return { killed: 2 };
    });
    await h.lifecycle.stopAllAndContinue();
    expect(h.c2.calls('server.stopAll')).toHaveLength(1);
    expect(h.runs()).toBe(1);
    expect(h.state()).toBe('connected');
  });
});

describe('createServerLifecycle F9 and explicit actions', () => {
  it('finished of supervisor without marker → start rule, 4th within the hour → stopped', async () => {
    const h = await harness();
    await h.lifecycle.start();
    expect(h.runs()).toBe(1);
    for (let restart = 1; restart <= VANISHED_RESTART_BUDGET.attempts; restart++) {
      h.clock.now += 10 * 60_000;
      await h.killSupervisorTerminal();
      h.c2.dropClients();
      await until(
        () => h.runs() === restart + 1 && h.state() === 'connected',
        `restart ${restart}`,
      );
    }
    h.clock.now += 10 * 60_000;
    await h.killSupervisorTerminal();
    h.c2.dropClients();
    await until(() => h.state() === 'stopped', 'stopped');
    expect(h.runs()).toBe(VANISHED_RESTART_BUDGET.attempts + 1);
    expect(h.lifecycle.current()).toMatchObject({ logPath: expect.stringContaining('server.log') });
  });

  it('vanishes spread over more than the hour never stop it', async () => {
    const h = await harness();
    await h.lifecycle.start();
    for (let restart = 1; restart <= VANISHED_RESTART_BUDGET.attempts + 2; restart++) {
      h.clock.now += VANISHED_RESTART_BUDGET.windowMs / 2;
      await h.killSupervisorTerminal();
      await until(
        () => h.runs() === restart + 1 && h.state() === 'connected',
        `restart ${restart}`,
      );
    }
  });

  it('C2 close with no live supervisor → start rule (a plain-spawned supervisor has no watch)', async () => {
    const h = await harness();
    h.cliResult.code = 1;
    h.cliResult.stderr = 'error: spawn failed';
    await h.lifecycle.start();
    expect(h.spawned).toHaveLength(1);
    h.c2.dropClients();
    await until(() => h.spawned.length === 2 && h.state() === 'connected', 'restarted');
  });

  it('retry deletes marker then applies start rule', async () => {
    const h = await harness({ marker: true });
    await h.lifecycle.start();
    expect(h.state()).toBe('unavailable');
    await h.lifecycle.retry();
    expect(h.flags.marker).toBe(false);
    expect(h.runs()).toBe(1);
    expect(h.state()).toBe('connected');
  });

  it('restartService kills by supervisorName then starts', async () => {
    const h = await harness({ supervisorLive: true });
    await h.lifecycle.start();
    expect(h.cliCalls).toEqual([]);
    await h.lifecycle.restartService();
    expect(h.cliCalls.map((a) => a.slice(0, 2))).toEqual([
      ['kill', SUPERVISOR],
      ['run', '--bg'],
    ]);
    expect(h.state()).toBe('connected');
  });

  it('stopAll returns killed and does not treat the following exit as a vanish', async () => {
    const h = await harness();
    await h.lifecycle.start();
    h.c2.on('server.stopAll', () => {
      setTimeout(() => {
        h.c2.dropClients();
        void h.killSupervisorTerminal();
      }, 10);
      return { killed: 3 };
    });
    expect(await h.lifecycle.stopAll()).toEqual({ ok: true, killed: 3 });
    await until(() => h.supervisor() === undefined, 'supervisor gone');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs()).toBe(1);
  });

  it('C2 close with live supervisor → reconnecting, reopen with backoff 500ms→5s', async () => {
    const h = await harness({ supervisorLive: true });
    await h.lifecycle.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opened = h.clients();
    await h.c2.close();
    await until(() => h.state() === 'reconnecting', 'reconnecting');
    const attempts = () => h.clients() - opened;
    for (const [i, delay] of [500, 1000, 2000, 4000, 5000, 5000].entries()) {
      await until(() => h.settled() === opened + i && vi.getTimerCount() > 0, `sleep ${i}`);
      vi.advanceTimersByTime(delay - 1);
      await new Promise((r) => setImmediate(r));
      expect(attempts()).toBe(i);
      vi.advanceTimersByTime(1);
      await until(() => attempts() === i + 1, `attempt ${i + 1}`);
    }
    expect(h.runs()).toBe(0);
    await h.c2.listen();
    await until(() => h.settled() === opened + 6 && vi.getTimerCount() > 0, 'last sleep');
    vi.advanceTimersByTime(5000);
    await until(() => h.state() === 'connected', 'reconnected');
    expect(h.states.map((s) => s.state)).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connected',
    ]);
  });
});
