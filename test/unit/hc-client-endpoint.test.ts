import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHcEndpoint } from '../../src/hc-client/endpoint';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hc endpoint resolution', () => {
  it('resolves a trimmed session under XDG_RUNTIME_DIR independently of host platform', () => {
    expect(
      resolveHcEndpoint({
        session: ' mine ',
        platform: 'linux',
        env: { XDG_RUNTIME_DIR: '/runtime', XDG_CONFIG_HOME: '/no-hc-config' },
      }),
    ).toBe('/runtime/herdr-core/mine.sock');
  });

  it('uses HC_SESSION and the state fallback when no runtime directory exists', () => {
    expect(
      resolveHcEndpoint({
        platform: 'linux',
        uid: 987654321,
        env: { HC_SESSION: 'ci', XDG_STATE_HOME: '/state', XDG_CONFIG_HOME: '/no-hc-config' },
      }),
    ).toBe('/state/herdr-core/ci/ci.sock');
  });

  it('honors HC_SOCKET before config and config before the default endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-config-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'herdr-core'));
    writeFileSync(join(dir, 'herdr-core', 'config.toml'), 'socket = "/custom/core.sock"\n');
    const env = { XDG_CONFIG_HOME: dir, XDG_RUNTIME_DIR: '/runtime' };
    expect(resolveHcEndpoint({ platform: 'linux', env })).toBe('/custom/core.sock');
    expect(
      resolveHcEndpoint({ platform: 'linux', env: { ...env, HC_SOCKET: '/explicit.sock' } }),
    ).toBe('/explicit.sock');
  });

  it('rejects sessions that could escape their state or endpoint directory', () => {
    for (const session of ['..', '.', 'a/b', 'a\\b', 'a:b', 'a\tb']) {
      expect(() => resolveHcEndpoint({ session, env: {} })).toThrow(/session/i);
    }
  });
});
