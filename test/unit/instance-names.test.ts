import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { supervisorEnv } from '../../electron/hc-cli';
import { serverChildEnv, serverProcessEnv } from '../../server/hc-cli';
import { HC_PINNED_VERSION } from '../../src/contracts/hc';
import { coreStartEnv } from '../../src/contracts/session-identity';
import { resolveHcEndpoint } from '../../src/hc-client/endpoint';
import { instanceNames } from '../../src/instance-names';

const posixOptions = { home: '/home/conduit-test', uid: 1000, runtimeDir: '' };

describe('instanceNames', () => {
  it('uses a case-folded Windows identity for both named pipes and hc names', () => {
    const names = instanceNames('ABC', 'win32', 'TEMP');

    expect(names).toEqual({
      instance: 'ba7816bf8f01cfea',
      serverEndpoint: '\\\\.\\pipe\\conduit-server-ba7816bf8f01cfea',
      mcpEndpoint: '\\\\.\\pipe\\conduit-mcp-ba7816bf8f01cfea',
      supervisorName: 'conduit-server-ba7816bf8f01cfea',
      hcSession: 'conduit-ba7816bf8f01cfea',
      runtimeRoot: 'ABC\\runtime',
      hcConfigHome: 'ABC\\hc\\config',
      hcStateHome: 'ABC\\hc\\state',
    });
  });

  it('keeps the POSIX userData identity case-sensitive and uses profile sockets', () => {
    const names = instanceNames('abc', 'posix', '/tmp', posixOptions);
    expect(instanceNames('ABC', 'posix', '/tmp', posixOptions).instance).not.toBe(names.instance);

    expect(names).toEqual({
      instance: 'ba7816bf8f01cfea',
      serverEndpoint: 'abc/conduit-server.sock',
      mcpEndpoint: 'abc/conduit-mcp/mcp.sock',
      supervisorName: 'conduit-server-ba7816bf8f01cfea',
      hcSession: 'conduit-ba7816bf8f01cfea',
      runtimeRoot: 'abc/runtime',
      hcConfigHome: 'abc/hc/config',
      hcStateHome: 'abc/hc/state',
    });
  });

  it('moves an overlong UTF-8 POSIX server socket into tmpdir', () => {
    const userData = '\u00e9'.repeat(45);
    const names = instanceNames(userData, 'posix', '/tmp', posixOptions);

    expect(names.serverEndpoint).toBe(`/tmp/conduit-server-${names.instance}.sock`);
  });
});

describe('hc socket budget', () => {
  const options = { home: '/Users/james', uid: 501, runtimeDir: '' };
  const userData = '/Users/james/Library/Application Support/conduit';
  const holder = (socket: string) => socket.replace(/\.sock$/, '.holder.xxxxxxxx.sock');

  it('requires re-measuring the limits and holder layout when the pinned hc changes', () => {
    expect(HC_PINNED_VERSION, 'Re-measure sockets/holders: macos-latest run 41914386091').toBe(
      '0.1.16',
    );
  });

  it('records a malformed config as an endpoint failure instead of aborting startup', () => {
    const profile = mkdtempSync(join(tmpdir(), 'hc-invalid-config-'));
    try {
      const config = join(profile, 'hc', 'config', 'herdr-core');
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, 'config.toml'), 'socket = [broken');
      const messages: string[] = [];
      const names = instanceNames(profile, 'darwin', '/tmp', {
        ...options,
        log: (m) => messages.push(m),
      });
      expect(names.hcEndpointError).toMatch(/toml|parse|invalid|unexpected/i);
      expect(messages.join('\n')).toContain(names.hcEndpointError);
      expect(names.serverEndpoint).toBeTruthy();
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it('shortens the Mac profile endpoint, including the longer holder socket', () => {
    const names = instanceNames(userData, 'darwin', '/tmp', options);
    expect(names.hcSocket).toMatch(
      /^\/Users\/james\/\.local\/state\/conduit-hc\/[a-f0-9]{8}\.sock$/,
    );
    expect(names.hcSocket?.endsWith(`${names.instance.slice(0, 8)}.sock`)).toBe(true);
    expect(Buffer.byteLength(holder(names.hcSocket ?? ''))).toBeLessThanOrEqual(103);
  });

  it('replaces a 139-byte state-home socket like the reported failure', () => {
    const profile = `/${'p'.repeat(63)}`;
    const names = instanceNames(profile, 'darwin', '/tmp', options);
    const oldEndpoint = resolveHcEndpoint({
      platform: 'darwin',
      uid: 501,
      runtimeDir: '',
      env: {
        HC_SESSION: names.hcSession,
        XDG_CONFIG_HOME: names.hcConfigHome,
        XDG_STATE_HOME: names.hcStateHome,
      },
    });
    expect(Buffer.byteLength(oldEndpoint)).toBe(139);
    expect(names.hcSocket).toBeDefined();
    expect(Buffer.byteLength(holder(names.hcSocket ?? ''))).toBeLessThanOrEqual(103);
  });

  it.each(['darwin', 'linux'] as const)('keeps a short default endpoint on %s', (platform) => {
    expect(instanceNames('/u', platform, '/tmp', options).hcSocket).toBeUndefined();
  });

  it('preserves a working Linux runtime endpoint even with a long profile path', () => {
    const names = instanceNames(userData, 'linux', '/tmp', {
      ...options,
      runtimeDir: '/run/user/501',
    });
    expect(names.hcSocket).toBeUndefined();
  });

  it('uses the platform byte limit for the default holder, not just the core socket', () => {
    const profile = `/${'u'.repeat(15)}`;
    expect(instanceNames(profile, 'linux', '/tmp', options).hcSocket).toBeUndefined();
    expect(instanceNames(profile, 'darwin', '/tmp', options).hcSocket).toBeDefined();
  });

  it('counts UTF-8 bytes for the durable holder and logs a per-user tmp fallback', () => {
    const messages: string[] = [];
    const names = instanceNames(userData, 'darwin', '/tmp', {
      ...options,
      home: `/Users/${'é'.repeat(30)}`,
      log: (m) => messages.push(m),
    });
    expect(names.hcSocket).toMatch(/^\/tmp\/conduit-hc-501\/[a-f0-9]{8}\.sock$/);
    expect(Buffer.byteLength(holder(names.hcSocket ?? ''))).toBeLessThanOrEqual(103);
    expect(messages.join('\n')).toMatch(/temporary.*\/tmp\/conduit-hc-501/i);
  });

  it('records a clear startup failure if neither holder fits', () => {
    const names = instanceNames(userData, 'darwin', `/${'t'.repeat(100)}`, {
      ...options,
      home: `/${'h'.repeat(100)}`,
      log: () => {},
    });
    expect(names.hcEndpointError).toMatch(/hc.*socket.*103.*bytes/i);
  });

  it('records a missing usable user id instead of aborting startup', () => {
    const names = instanceNames(userData, 'darwin', '/tmp', {
      ...options,
      uid: -1,
      home: `/${'h'.repeat(100)}`,
      log: () => {},
    });
    expect(names.hcEndpointError).toMatch(/POSIX user id/);
  });

  it('never overrides Windows named pipes, even for long paths', () => {
    const names = instanceNames(`C:\\${'x'.repeat(200)}`, 'win32', 'TEMP', options);
    expect(names.hcSocket).toBeUndefined();
    expect(coreStartEnv({ HC_SOCKET: '/foreign.sock' }, names).HC_SOCKET).toBeUndefined();
  });

  it('gives app, supervisor, server, restart and endpoint resolution the same socket', () => {
    const names = instanceNames(userData, 'darwin', '/tmp', options);
    const app = coreStartEnv({ HC_SOCKET: '/foreign.sock' }, names);
    expect(app.HC_SOCKET).toBeDefined();
    expect(app.HC_SOCKET).toBe(names.hcSocket);
    const supervisor = { ...app, ...supervisorEnv(app, names) };
    const server = serverProcessEnv(supervisor, names);
    const serverHc = serverChildEnv(server, names);
    const restart = coreStartEnv(serverHc, names);
    for (const env of [app, serverHc, restart]) {
      expect(env.HC_SOCKET).toBe(app.HC_SOCKET);
      expect(resolveHcEndpoint({ env, platform: 'darwin', uid: 501 })).toBe(app.HC_SOCKET);
    }
    expect(coreStartEnv({}, names).HC_SOCKET).toBe(app.HC_SOCKET);
  });
});
