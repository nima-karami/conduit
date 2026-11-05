import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type HcCliDeps,
  killSupervisor,
  startSupervisor,
  supervisorEnv,
} from '../../electron/hc-cli';
import {
  HC_XDG_ISOLATED_ENV,
  hcBinaryOf,
  hcClient,
  serverChildEnv,
  serverProcessEnv,
} from '../../server/hc-cli';
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
    env: coreStartEnv(APP_ENV, names),
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
  it('standalone and uninstall calls default to the copied Conduit runtime, not PATH', () => {
    expect(hcBinaryOf(undefined, names, 'linux')).toBe(
      join('/u/runtime', 'conduit-hc', '0.1.16', 'conduit-hc'),
    );
    expect(hcBinaryOf('/explicit/test-hc', names, 'linux')).toBe('/explicit/test-hc');
  });
  it('does not dial a default endpoint after socket resolution failed', async () => {
    const client = hcClient({ ...names, hcEndpointError: 'invalid hc endpoint' }, {}, () => {});
    try {
      await expect(client.call('terminal.list', {})).rejects.toMatchObject({
        cause: { message: 'invalid hc endpoint' },
      });
    } finally {
      client.close();
    }
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
      ...supervisorEnv(coreStartEnv(APP_ENV, names), names),
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
    const server = serverProcessEnv(coreStartEnv(APP_ENV, names), names);
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
