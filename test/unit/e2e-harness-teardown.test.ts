import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { supervisorEnv } from '../../electron/hc-cli';
import { serverChildEnv, serverProcessEnv } from '../../server/hc-cli';
import {
  SERVER_PROTOCOL_GENERATION,
  STOP_ALL_ANSWER_TIMEOUT_MS,
  STOP_ALL_CONNECT_TIMEOUT_MS,
} from '../../src/contracts/server-protocol';
import { coreStartEnv } from '../../src/contracts/session-identity';
import { instanceNames } from '../../src/instance-names';
// @ts-expect-error plain .mjs harness module, no declarations
import * as td from '../e2e/harness-server-teardown.mjs';

const POSIX_DIR = '/tmp/conduit-e2e-profile/run-1';
const posixOptions = { home: '/home/conduit-test', uid: 1000, runtimeDir: '' };

describe('teardown and cross-process identity', () => {
  it('imports on an unbuilt worktree without resolving the built identity module', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hc-unbuilt-harness-'));
    try {
      const file = join(directory, 'harness.mjs');
      copyFileSync(join(__dirname, '..', 'e2e', 'harness-server-teardown.mjs'), file);
      copyFileSync(join(__dirname, '..', 'e2e', 'hc-binary.mjs'), join(directory, 'hc-binary.mjs'));
      const unloaded = await import(pathToFileURL(file).href);
      expect(() => unloaded.assertOwnSession('conduit-test', undefined)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recomputes the server socket identity from the environment passed by the app', () => {
    const profile = '/Users/james/Library/Application Support/conduit';
    const appNames = instanceNames(profile, 'darwin', '/tmp', {
      home: '/Users/james',
      uid: 501,
      runtimeDir: '',
    });
    const appEnv = coreStartEnv(
      { HOME: '/Users/james', XDG_RUNTIME_DIR: '', HC_SOCKET: '/foreign.sock' },
      appNames,
    );
    const supervisor = { ...appEnv, ...supervisorEnv(appEnv, appNames) };
    const serverEnv = serverProcessEnv(supervisor, appNames);
    const serverNames = instanceNames(profile, 'darwin', '/tmp', {
      home: serverEnv.HOME,
      uid: 501,
      runtimeDir: serverEnv.XDG_RUNTIME_DIR,
    });
    const serverHc = serverChildEnv(serverEnv, serverNames);
    expect(appEnv.HC_SOCKET).toMatch(
      /^\/Users\/james\/\.local\/state\/conduit-hc\/[a-f0-9]{8}\.sock$/,
    );
    expect(serverHc.HC_SOCKET).toBe(appEnv.HC_SOCKET);
    expect(serverHc.HC_SESSION).toBe(appEnv.HC_SESSION);
  });

  it('mirrors the protocol constants', () => {
    expect(td.STOP_ALL_CONNECT_TIMEOUT_MS).toBe(STOP_ALL_CONNECT_TIMEOUT_MS);
    expect(td.STOP_ALL_ANSWER_TIMEOUT_MS).toBe(STOP_ALL_ANSWER_TIMEOUT_MS);
    expect(td.SERVER_PROTOCOL_GENERATION).toBe(SERVER_PROTOCOL_GENERATION);
  });
});

describe('session guard', () => {
  it('refuses a non conduit-* session', () => {
    expect(() => td.assertOwnSession('main', undefined)).toThrow(/not conduit-/);
  });
  it("refuses the runner's own session", () => {
    expect(() => td.assertOwnSession('conduit-abc', 'conduit-abc')).toThrow(/runner/);
  });
  it('accepts a derived session', () => {
    expect(() => td.assertOwnSession('conduit-abc', 'conduit-other')).not.toThrow();
  });
});

describe('hc env', () => {
  it('teardown stops the same short Mac endpoint the app starts', () => {
    const options = { home: '/Users/james', uid: 501, runtimeDir: '' };
    const profile = '/Users/james/Library/Application Support/conduit';
    const names = td.teardownNames(profile, 'darwin', '/tmp', options);
    const app = instanceNames(profile, 'darwin', '/tmp', options);
    const calls: { env: Record<string, string> }[] = [];
    td.stopHc({
      exec: (_bin: string, _args: string[], o: { env: Record<string, string> }) => {
        calls.push(o);
        return { status: 0 };
      },
      bin: 'hc',
      names,
      inheritedEnv: { HC_SOCKET: '/foreign.sock' },
      log: () => {},
    });
    expect(app.hcSocket).toBeDefined();
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.env.HC_SOCKET).toBe(app.hcSocket);
  });

  it('strips every inherited HC_* and sets our session and XDG dirs', () => {
    const env = td.hcEnv(
      { PATH: '/bin', HC_SESSION: 'x', hc_config_home: '/c', HC_STATE_HOME: '/s', HOME: '/h' },
      { hcSession: 'conduit-1', hcConfigHome: '/u/hc/config', hcStateHome: '/u/hc/state' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      HC_SESSION: 'conduit-1',
      XDG_CONFIG_HOME: '/u/hc/config',
      XDG_STATE_HOME: '/u/hc/state',
      CONDUIT_USER_XDG_CONFIG_HOME: '',
      CONDUIT_USER_XDG_STATE_HOME: '',
      CONDUIT_USER_XDG_CAPTURED: '1',
    });
  });
});

describe('teardownScenarioServer', () => {
  const names = td.teardownNames(POSIX_DIR, 'posix', '/tmp', posixOptions);
  const base = { userDataDir: POSIX_DIR, tmpdir: '/tmp', platform: 'linux', appVersion: '1.2.3' };

  it('still runs the hc steps when no server answers', async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    await td.teardownScenarioServer({
      ...base,
      env: { HC_SESSION: 'conduit-keep', CONDUIT_HC_BINARY: '/test/conduit-hc' },
      log: (m: string) => logs.push(m),
      stopAll: async () => ({ outcome: 'no-server' }),
      exec: (...a: unknown[]) => {
        calls.push(a);
        return { status: 0 };
      },
    });
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/no-server/);
  });

  it('kills the supervisor then stops the server under our session only', async () => {
    const calls: { args: string[]; env: Record<string, string>; bin: string }[] = [];
    await td.teardownScenarioServer({
      ...base,
      env: { HC_SESSION: 'conduit-keep', HC_CONFIG_HOME: '/x', CONDUIT_HC_BINARY: '/opt/hc' },
      log: () => {},
      stopAll: async () => ({ outcome: 'stopped', detail: 'killed 2' }),
      exec: (bin: string, args: string[], o: { env: Record<string, string> }) => {
        calls.push({ bin, args, env: o.env });
        return { status: 0 };
      },
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['kill', names.supervisorName],
      ['server', 'stop'],
    ]);
    for (const c of calls) {
      expect(c.bin).toBe('/opt/hc');
      expect(c.env.HC_SESSION).toBe(names.hcSession);
      expect(c.env.HC_CONFIG_HOME).toBeUndefined();
      expect(c.env.XDG_CONFIG_HOME).toBe(names.hcConfigHome);
      expect(c.env.XDG_STATE_HOME).toBe(names.hcStateHome);
    }
  });

  it('ignores not_found and not running, logs other failures, never throws', async () => {
    const logs: string[] = [];
    const results = [
      { status: 1, stderr: 'error: not_found' },
      { status: 1, stderr: 'server not running' },
    ];
    await td.teardownScenarioServer({
      ...base,
      env: { CONDUIT_HC_BINARY: '/test/conduit-hc' },
      log: (m: string) => logs.push(m),
      stopAll: async () => ({ outcome: 'closed' }),
      exec: () => results.shift(),
    });
    expect(logs.filter((l) => l.includes('nothing to stop'))).toHaveLength(2);

    const logs2: string[] = [];
    await td.teardownScenarioServer({
      ...base,
      env: { CONDUIT_HC_BINARY: '/test/conduit-hc' },
      log: (m: string) => logs2.push(m),
      stopAll: async () => ({ outcome: 'closed' }),
      exec: () => ({ status: 3, stderr: 'boom' }),
    });
    expect(logs2.join('\n')).toMatch(/exit 3: boom/);
  });

  it('skips with a log line when hc is missing', async () => {
    const logs: string[] = [];
    let n = 0;
    await td.teardownScenarioServer({
      ...base,
      env: { CONDUIT_HC_BINARY: '/test/conduit-hc' },
      log: (m: string) => logs.push(m),
      stopAll: async () => ({ outcome: 'closed' }),
      exec: () => {
        n++;
        return { status: null, error: { code: 'ENOENT' } };
      },
    });
    expect(n).toBe(1);
    expect(logs.join('\n')).toMatch(/hc unavailable/);
  });

  it('does not swallow the session guard', async () => {
    await expect(
      td.teardownScenarioServer({
        ...base,
        env: { HC_SESSION: names.hcSession },
        log: () => {},
        stopAll: async () => ({ outcome: 'stopped' }),
        exec: () => ({ status: 0 }),
      }),
    ).rejects.toThrow(/runner/);
  });

  it('survives a throwing exec', async () => {
    const logs: string[] = [];
    await td.teardownScenarioServer({
      ...base,
      env: { CONDUIT_HC_BINARY: '/test/conduit-hc' },
      log: (m: string) => logs.push(m),
      stopAll: async () => ({ outcome: 'stopped' }),
      exec: () => {
        throw new Error('spawn exploded');
      },
    });
    expect(logs.join('\n')).toMatch(/spawn exploded/);
  });
});

describe('stopAllViaServer', () => {
  let server: Server | undefined;
  afterEach(
    () =>
      new Promise<void>((r) => {
        const s = server;
        server = undefined;
        if (s) s.close(() => r());
        else r();
      }),
  );

  const endpoint = () =>
    process.platform === 'win32'
      ? `\\\\.\\pipe\\conduit-teardown-test-${process.pid}-${Date.now()}`
      : join(tmpdir(), `cts-${process.pid}-${Date.now()}.sock`);

  it('reports no-server when nothing listens', async () => {
    const r = await td.stopAllViaServer({ endpoint: endpoint(), appVersion: '1.0.0' });
    expect(r.outcome).toBe('no-server');
  });

  it('sends hello then server.stopAll and reads the reply', async () => {
    const seen: { method: string; params: unknown }[] = [];
    server = createServer((s) => {
      let buf = '';
      s.on('data', (c) => {
        buf += c;
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          seen.push({ method: msg.method, params: msg.params });
          const result = msg.method === 'hello' ? { serverVersion: '1' } : { killed: 3 };
          s.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
        }
      });
    });
    const ep = endpoint();
    await new Promise<void>((r) => server?.listen(ep, r));
    const r = await td.stopAllViaServer({ endpoint: ep, appVersion: '9.9.9' });
    expect(r).toEqual({ outcome: 'stopped', detail: 'killed 3' });
    expect(seen).toEqual([
      { method: 'hello', params: { appVersion: '9.9.9', generation: SERVER_PROTOCOL_GENERATION } },
      { method: 'server.stopAll', params: {} },
    ]);
  });

  it('settles on socket close without a reply', async () => {
    server = createServer((s) => s.on('data', () => s.destroy()));
    const ep = endpoint();
    await new Promise<void>((r) => server?.listen(ep, r));
    const r = await td.stopAllViaServer({ endpoint: ep, appVersion: '1.0.0' });
    expect(r.outcome).toBe('closed');
  });

  it('bounds a server that never answers', async () => {
    server = createServer((s) => s.resume());
    const ep = endpoint();
    await new Promise<void>((r) => server?.listen(ep, r));
    const r = await td.stopAllViaServer({
      endpoint: ep,
      appVersion: '1.0.0',
      connectTimeoutMs: 50,
    });
    expect(r.outcome).toBe('timeout');
  });
});
