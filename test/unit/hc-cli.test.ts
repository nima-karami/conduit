import { describe, expect, it } from 'vitest';
import { type HcCliDeps, killSupervisor, startSupervisor } from '../../electron/hc-cli';
import {
  CORE_START_RUN_FLAGS,
  coreStartEnv,
  type InstanceNames,
} from '../../src/contracts/session-identity';

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

function cli(result = { code: 0, stdout: '', stderr: '' }) {
  const calls: { file: string; args: string[]; env: Record<string, string>; cwd: string }[] = [];
  const deps: HcCliDeps = {
    hcExe: '/rt/hc.exe',
    // As the app builds it: the parent's HC_* (a Conduit/Herdr pane) never reaches our hc.
    env: coreStartEnv(
      { PATH: '/bin', HC_SESSION: 'users-own', HC_TERMINAL_ID: 't9', hc_parent: 'x' },
      names,
      true,
    ),
    coreCwd: '/u/runtime/hc/0.1.16',
    execFile: async (file, args, o) => {
      calls.push({ file, args, env: o.env, cwd: o.cwd });
      return result;
    },
  };
  return { deps, calls };
}

describe('hc-cli', () => {
  it('startSupervisor argv uses CORE_START_RUN_FLAGS, unique name, cwd coreCwd, env without HC_*', async () => {
    const { deps, calls } = cli();
    const r = await startSupervisor(deps, {
      names,
      nodeExe: '/rt/node.exe',
      superviseJs: '/rt/server/supervise.js',
      userData: '/u',
      serverArgs: ['--e2e'],
    });
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.file).toBe('/rt/hc.exe');
    expect(call.args).toEqual([
      'run',
      ...CORE_START_RUN_FLAGS,
      '--name',
      'conduit-server-abc',
      '--label',
      'conduit.role=server',
      '--label',
      'conduit.instance=abc',
      '--',
      '/rt/node.exe',
      '/rt/server/supervise.js',
      '--user-data',
      '/u',
      '--e2e',
    ]);
    expect(CORE_START_RUN_FLAGS).toEqual(['--bg', '--no-parent']);
    expect(call.cwd).toBe('/u/runtime/hc/0.1.16');
    const hcKeys = Object.keys(call.env).filter((k) => k.toUpperCase().startsWith('HC_'));
    expect(hcKeys).toEqual(['HC_SESSION']);
    expect(call.env.HC_SESSION).toBe('conduit-abc');
  });

  it('a failed run reports hc stderr', async () => {
    const { deps } = cli({ code: 1, stdout: '', stderr: 'error: name_taken\n' });
    const r = await startSupervisor(deps, {
      names,
      nodeExe: 'node',
      superviseJs: 's.js',
      userData: '/u',
      serverArgs: [],
    });
    expect(r).toEqual({ ok: false, reason: 'error: name_taken' });
  });

  it('killSupervisor kills by the unique name only', async () => {
    const { deps, calls } = cli();
    expect(await killSupervisor(deps, names)).toEqual({ ok: true });
    expect(calls.map((c) => [c.args, c.cwd])).toEqual([
      [['kill', 'conduit-server-abc'], '/u/runtime/hc/0.1.16'],
    ]);
  });
});
