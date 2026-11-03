import { describe, expect, it } from 'vitest';
import {
  type HcCliDeps,
  killSupervisor,
  startSupervisor,
  supervisorEnv,
} from '../../electron/hc-cli';
import {
  directStopAll,
  directStopSessions,
  HC_XDG_ISOLATED_ENV,
  serverChildEnv,
  serverProcessEnv,
} from '../../server/hc-cli';
import type { HcClient } from '../../src/contracts/hc';
import {
  CORE_START_RUN_FLAGS,
  coreStartEnv,
  type InstanceNames,
} from '../../src/contracts/session-identity';
import { HcDisconnectedError, HcRpcError } from '../../src/hc-client';

const names: InstanceNames = {
  instance: 'abc',
  serverEndpoint: '/u/conduit-server.sock',
  mcpEndpoint: '/u/conduit-mcp.sock',
  supervisorName: 'conduit-server-abc',
  hcSession: 'conduit-abc',
  runtimeRoot: '/u/runtime',
  hcConfigHome: '/u/hc/config',
  hcStateHome: '/u/hc/state',
};

/** The app's own env: launched from a Herdr pane, the user has XDG_CONFIG_HOME but no state home. */
const APP_ENV = {
  PATH: '/bin',
  HOME: '/home/u',
  CONDUIT_E2E_X: '1',
  XDG_CONFIG_HOME: '/mine',
  HC_SESSION: 'users-own',
  HC_TERMINAL_ID: 't9',
  hc_parent: 'x',
};

const hcKeys = (env: Record<string, string>) =>
  Object.keys(env).filter((k) => k.toUpperCase().startsWith('HC_'));
const hasOurDirs = (env: Record<string, string>) =>
  Object.values(env).some((v) => v === names.hcConfigHome || v === names.hcStateHome);

function cli(
  o: {
    result?: { code: number; stdout: string; stderr: string };
    run?: (params: unknown, attempt: number) => Promise<unknown>;
    startCore?: () => Promise<void>;
  } = {},
) {
  const trace: string[] = [];
  const execCalls: { args: string[]; cwd: string }[] = [];
  const runs: Record<string, unknown>[] = [];
  let closed = 0;
  const deps: HcCliDeps = {
    hcExe: '/rt/hc.exe',
    // As the app builds it: the parent's HC_* (a Conduit/Herdr pane) never reaches our hc.
    env: coreStartEnv(APP_ENV, names, true),
    coreCwd: '/u/runtime/hc/0.1.16',
    execFile: async (_file, args, x) => {
      execCalls.push({ args, cwd: x.cwd });
      return o.result ?? { code: 0, stdout: '', stderr: '' };
    },
    startCore: async () => {
      trace.push('startCore');
      await o.startCore?.();
    },
    connect: () => ({
      call: (async (method: string, params: Record<string, unknown>) => {
        trace.push(method);
        runs.push(params);
        if (o.run) return o.run(params, runs.length - 1);
        return {};
      }) as never,
      close: () => {
        closed++;
      },
    }),
  };
  return { deps, trace, execCalls, runs, closed: () => closed };
}

const START = {
  names,
  nodeExe: '/rt/node.exe',
  superviseJs: '/rt/server/supervise.js',
  userData: '/u',
  serverArgs: ['--e2e'],
};

describe('hc-cli', () => {
  it('strips inherited Node IPC variables before spawning hc descendants', () => {
    const env = serverChildEnv(
      {
        ...APP_ENV,
        NODE_CHANNEL_FD: '3',
        NODE_CHANNEL_SERIALIZATION_MODE: 'json',
      },
      names,
    );
    expect(Object.keys(env).filter((key) => key.startsWith('NODE_CHANNEL_'))).toEqual([]);
    expect(env.PATH).toBe('/bin');
    expect(env.HC_SESSION).toBe(names.hcSession);
  });

  function stopClient(options: { killError?: Error; listError?: Error } = {}) {
    const trace: unknown[] = [];
    let lists = 0;
    const hc: HcClient = {
      call: (async (method: string, params: unknown) => {
        trace.push({ method, params });
        if (method === 'terminal.list') {
          if (options.listError) throw options.listError;
          return {
            terminals:
              ++lists === 1
                ? [
                    { address: 'agent-1', state: 'live' },
                    { address: 'agent-2', state: 'live' },
                  ]
                : [],
          };
        }
        if (method === 'terminal.get') return { address: 'supervisor', state: 'live' };
        if (method === 'terminal.kill' && options.killError) throw options.killError;
        return {};
      }) as HcClient['call'],
      attach: async () => {
        throw new Error('unexpected terminal attach');
      },
      subscribe: async () => {
        throw new Error('unexpected terminal subscription');
      },
      onConnection: () => {
        throw new Error('unexpected connection subscription');
      },
      close: () => {
        trace.push('close');
      },
    };
    return { hc, trace };
  }

  it('directStopSessions kills only the labelled sessions and leaves its client to the caller', async () => {
    const { hc, trace } = stopClient();
    await expect(directStopSessions(hc, names)).resolves.toBe(2);
    expect(trace).toEqual([
      {
        method: 'terminal.list',
        params: { labels: { 'conduit.instance': 'abc', 'conduit.role': 'session' } },
      },
      { method: 'terminal.kill', params: { terminal: 'agent-1' } },
      { method: 'terminal.kill', params: { terminal: 'agent-2' } },
    ]);
  });

  it('directStopSessions tolerates terminals disappearing without counting them as killed', async () => {
    const { hc, trace } = stopClient({
      killError: new HcRpcError(-32000, 'gone', { kind: 'not_found' }),
    });
    await expect(directStopSessions(hc, names)).resolves.toBe(0);
    expect(trace).toEqual([
      {
        method: 'terminal.list',
        params: { labels: { 'conduit.instance': 'abc', 'conduit.role': 'session' } },
      },
      { method: 'terminal.kill', params: { terminal: 'agent-1' } },
      { method: 'terminal.kill', params: { terminal: 'agent-2' } },
    ]);
  });

  it('directStopSessions reports hc disconnects and kill failures to its caller', async () => {
    for (const options of [
      { listError: new HcDisconnectedError() },
      { killError: new Error('kill denied') },
    ]) {
      const { hc } = stopClient(options);
      await expect(directStopSessions(hc, names)).rejects.toBe(
        options.listError ?? options.killError,
      );
    }
  });

  it('directStopAll keeps its session, supervisor, re-list, close and core-stop ordering', async () => {
    const { hc, trace } = stopClient();
    await expect(
      directStopAll(hc, names, async () => {
        trace.push('stop');
      }),
    ).resolves.toBe(2);
    expect(trace).toEqual([
      {
        method: 'terminal.list',
        params: { labels: { 'conduit.instance': 'abc', 'conduit.role': 'session' } },
      },
      { method: 'terminal.kill', params: { terminal: 'agent-1' } },
      { method: 'terminal.kill', params: { terminal: 'agent-2' } },
      { method: 'terminal.get', params: { terminal: 'conduit-server-abc' } },
      { method: 'terminal.kill', params: { terminal: 'supervisor' } },
      { method: 'terminal.list', params: {} },
      'close',
      'stop',
    ]);
  });

  it('directStopAll preserves its disconnected-core result and closes the client', async () => {
    const { hc, trace } = stopClient({ listError: new HcDisconnectedError() });
    await expect(
      directStopAll(hc, names, async () => {
        trace.push('stop');
      }),
    ).resolves.toBe(0);
    expect(trace).toEqual([
      {
        method: 'terminal.list',
        params: { labels: { 'conduit.instance': 'abc', 'conduit.role': 'session' } },
      },
      'close',
    ]);
  });

  it('startSupervisor ensures the core, then terminal.run with the unique name, labels, no_parent and argv', async () => {
    const { deps, trace, runs, execCalls, closed } = cli();
    expect(await startSupervisor(deps, START)).toEqual({ ok: true });
    expect(trace).toEqual(['startCore', 'terminal.run']);
    expect(execCalls).toEqual([]);
    expect(closed()).toBe(1);
    expect(runs[0]).toMatchObject({
      name: 'conduit-server-abc',
      labels: { 'conduit.role': 'server', 'conduit.instance': 'abc' },
      no_parent: true,
      cwd: '/u/runtime/hc/0.1.16',
      argv: [
        '/rt/node.exe',
        '/rt/server/supervise.js',
        '--user-data',
        '/u',
        '--hc',
        '/rt/hc.exe',
        '--e2e',
      ],
    });
    expect(CORE_START_RUN_FLAGS).toContain('--no-parent');
  });

  it("the supervisor's env: the app's, no HC_*, the user's XDG restored and never our hc dirs", async () => {
    const { deps, runs } = cli();
    await startSupervisor(deps, START);
    const env = runs[0].env as Record<string, string>;
    expect(hcKeys(env)).toEqual([]);
    expect(hasOurDirs(env)).toBe(false);
    expect(env.XDG_CONFIG_HOME).toBe('/mine');
    // Unset by the user: "" overrides the core's value, which terminal.run can't unset (M22).
    expect(env.XDG_STATE_HOME).toBe('');
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.CONDUIT_E2E_X).toBe('1');
    expect(env[HC_XDG_ISOLATED_ENV]).toBe('1');
  });

  it('the server gets the user XDG; its own hc env is isolated in our session', () => {
    // What the supervisor's pane sees: our env set over the core's, plus hc's own HC_*.
    const pane = {
      ...supervisorEnv(coreStartEnv(APP_ENV, names, true), names),
      HC_TERMINAL_ID: 't3',
    };
    const server = serverProcessEnv(pane, names);
    expect(hcKeys(server)).toEqual([]);
    expect(hasOurDirs(server)).toBe(false);
    expect(server.XDG_CONFIG_HOME).toBe('/mine');
    const hc = serverChildEnv(server, names);
    expect(hc.XDG_CONFIG_HOME).toBe(names.hcConfigHome);
    expect(hc.XDG_STATE_HOME).toBe(names.hcStateHome);
    expect(hc.HC_SESSION).toBe('conduit-abc');
    expect(hc.CONDUIT_USER_XDG_CONFIG_HOME).toBe('/mine');
    expect(hc.CONDUIT_USER_XDG_STATE_HOME).toBe('');
    expect(hc[HC_XDG_ISOLATED_ENV]).toBeUndefined();
  });

  it('a server under a `hc run` supervisor still never sees our hc dirs', () => {
    const server = serverProcessEnv(coreStartEnv(APP_ENV, names, true), names);
    expect(hasOurDirs(server)).toBe(false);
    expect(server.XDG_CONFIG_HOME).toBe('/mine');
    expect(server.XDG_STATE_HOME).toBe('');
    expect(serverChildEnv(server, names).XDG_STATE_HOME).toBe(names.hcStateHome);
  });

  it('a failed run reports the hc error kind', async () => {
    const { deps } = cli({
      run: async () => {
        throw new HcRpcError(-32000, 'a live terminal is already named', { kind: 'name_taken' });
      },
    });
    expect(await startSupervisor(deps, START)).toEqual({
      ok: false,
      reason: 'name_taken: a live terminal is already named',
    });
  });

  it('a core that will not start is a failed start (the detached fallback follows)', async () => {
    const { deps, trace } = cli({
      startCore: async () => {
        throw new Error('spawn hc ENOENT');
      },
    });
    expect(await startSupervisor(deps, START)).toEqual({
      ok: false,
      reason: 'hc server start: spawn hc ENOENT',
    });
    expect(trace).toEqual(['startCore']);
  });

  it('a dial that races the core start is retried once on a fresh client', async () => {
    const { deps, trace, closed } = cli({
      run: async (_p, attempt) => {
        if (attempt === 0) throw new HcDisconnectedError();
        return {};
      },
    });
    expect(await startSupervisor(deps, START)).toEqual({ ok: true });
    expect(trace).toEqual(['startCore', 'terminal.run', 'terminal.run']);
    expect(closed()).toBe(2);
  });

  it('killSupervisor kills by the unique name only', async () => {
    const { deps, execCalls } = cli();
    expect(await killSupervisor(deps, names)).toEqual({ ok: true });
    expect(execCalls.map((c) => [c.args, c.cwd])).toEqual([
      [['kill', 'conduit-server-abc'], '/u/runtime/hc/0.1.16'],
    ]);
  });
});
