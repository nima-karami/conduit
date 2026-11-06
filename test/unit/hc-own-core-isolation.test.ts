import { posix, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killSupervisor, supervisorEnv } from '../../electron/hc-cli';
import { serverChildEnv, serverProcessEnv } from '../../server/hc-cli';
import { coreStartEnv } from '../../src/contracts/session-identity';
import { resolveHcEndpoint } from '../../src/hc-client/endpoint';
import { instanceNames } from '../../src/instance-names';
// @ts-expect-error node harness module, no declarations
import { hcEnv } from '../e2e/harness-server-teardown.mjs';

const config = vi.hoisted(() => ({ files: new Map<string, string>(), reads: [] as string[] }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: (path: string) => config.files.has(String(path)),
    readFileSync: (path: string, ...args: unknown[]) => {
      const text = config.files.get(String(path));
      if (text === undefined) return Reflect.apply(fs.readFileSync, fs, [path, ...args]);
      config.reads.push(String(path));
      return text;
    },
  };
});
afterEach(() => {
  config.files.clear();
  config.reads.length = 0;
});

describe.each(['win32', 'darwin', 'linux'] as const)('Conduit hc isolation on %s', (platform) => {
  it.each([
    'app + Mac smoke',
    'server without marker',
    'supervisor + services + restart',
    'electron hc CLI',
    'harness',
  ])('%s ignores the user core endpoint and state', async (entry) => {
    const path = platform === 'win32' ? win32 : posix;
    const userData = platform === 'win32' ? 'C:\\profiles\\conduit' : '/profiles/conduit';
    const userConfig = platform === 'win32' ? 'C:\\user\\config' : '/user/config';
    const userSocket = platform === 'win32' ? '\\\\.\\pipe\\user-herdr' : '/user/herdr.sock';
    const userConfigFile = path.join(userConfig, 'herdr-core', 'config.toml');
    config.files.set(userConfigFile, `socket = ${JSON.stringify(userSocket)}`);
    const names = instanceNames(userData, platform, '/tmp', {
      home: '/home/conduit-test',
      uid: 1000,
      runtimeDir: '',
    });
    const hostile = {
      HC_SESSION: 'default',
      hc_socket: userSocket,
      HC_TERMINAL_ID: 't7',
      HC_TERMINAL_SOCKET: userSocket,
      HC_SCOPE: 'user-scope',
      XDG_CONFIG_HOME: userConfig,
      XDG_STATE_HOME: '/user/state',
      XDG_RUNTIME_DIR: '/user/run',
      APPDATA: userConfig,
      USERNAME: 'Me',
      PATH: '/user/bin',
    };
    let env: Record<string, string>;
    if (entry === 'server without marker') env = serverChildEnv(hostile, names);
    else if (entry === 'supervisor + services + restart') {
      const app = coreStartEnv(hostile, names);
      env = serverChildEnv(
        serverProcessEnv({ ...app, ...supervisorEnv(app, names) }, names),
        names,
      );
    } else if (entry === 'harness') env = hcEnv(hostile, names);
    else {
      env = coreStartEnv(hostile, names);
      if (entry === 'electron hc CLI') {
        let invoked: Record<string, string> | undefined;
        await killSupervisor(
          {
            hcExe: '/conduit/runtime/hc',
            env,
            coreCwd: '/conduit/runtime',
            execFile: async (_exe, _args, options) => {
              invoked = options.env;
              return { code: 0, stdout: '', stderr: '' };
            },
            startCore: async () => {},
            connect: () => {
              throw new Error('unused');
            },
          },
          names,
        );
        expect(invoked).toBeDefined();
        env = invoked ?? {};
      }
    }
    expect(env.XDG_CONFIG_HOME).toBe(names.hcConfigHome);
    expect(env.XDG_STATE_HOME).toBe(names.hcStateHome);
    expect(path.join(env.XDG_STATE_HOME, 'herdr-core', env.HC_SESSION)).toBe(
      path.join(names.hcStateHome, 'herdr-core', names.hcSession),
    );
    const endpoint = resolveHcEndpoint({ platform, env, uid: 1000, runtimeDir: '' });
    expect(endpoint).not.toBe(userSocket);
    expect(endpoint === names.hcSocket || endpoint.includes(names.hcSession)).toBe(true);
    expect(config.reads).not.toContain(userConfigFile);
    expect(
      Object.keys(env)
        .filter((key) => key.toUpperCase().startsWith('HC_'))
        .sort(),
    ).toEqual(names.hcSocket ? ['HC_SESSION', 'HC_SOCKET'] : ['HC_SESSION']);
  });
});
