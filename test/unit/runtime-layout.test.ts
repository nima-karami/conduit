import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeLayout } from '../../electron/runtime-layout';
import { prepareRuntime } from '../../server/runtime-dir/prepare';
import { HC_PINNED_VERSION } from '../../src/contracts/hc';

let userData = '';
afterEach(() => {
  if (userData) rmSync(userData, { recursive: true, force: true });
  userData = '';
});
const fresh = () => {
  userData = mkdtempSync(join(tmpdir(), 'runtime-layout-'));
  return userData;
};
const coreCwd = (u: string) => join(u, 'runtime', 'hc', HC_PINNED_VERSION);

describe('runtimeLayout', () => {
  it('packaged paths are the ones prepareRuntime produces', async () => {
    const u = fresh();
    const layout = runtimeLayout({
      packaged: true,
      userData: u,
      appVersion: '0.52.0',
      appPath: '/ignored',
      env: { CONDUIT_NODE_BINARY: '/dev/node', CONDUIT_HC_BINARY: '/dev/hc' },
    });
    const prepared = await prepareRuntime({
      resourcesDir: join(u, 'resources'),
      userData: u,
      appVersion: '0.52.0',
      hcVersion: HC_PINNED_VERSION,
      shimVersion: 1,
      fs: {
        access: async () => {},
        mkdir: async () => undefined,
        rm: async () => {},
        cp: async () => {},
        rename: async () => {},
      },
    });
    expect(layout).toEqual({
      nodeExe: prepared.nodeExe,
      superviseJs: prepared.superviseJs,
      hcExe: prepared.hcExe,
      hcVersion: HC_PINNED_VERSION,
      coreCwd: coreCwd(u),
    });
    expect(layout.nodeExe).toBe(join(u, 'runtime', '0.52.0', 'node.exe'));
    expect(existsSync(layout.coreCwd)).toBe(true);
  });

  it('unpackaged uses the build output and the env overrides, else PATH', () => {
    const u = fresh();
    const appPath = join(u, 'repo');
    const env = { CONDUIT_NODE_BINARY: '/dev/node', CONDUIT_HC_BINARY: '/dev/hc' };
    expect(
      runtimeLayout({ packaged: false, userData: u, appVersion: '0.52.0', appPath, env }),
    ).toEqual({
      nodeExe: '/dev/node',
      superviseJs: join(appPath, 'out', 'server', 'supervise.js'),
      hcExe: '/dev/hc',
      hcVersion: HC_PINNED_VERSION,
      coreCwd: coreCwd(u),
    });
    const bare = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath,
      env: {},
    });
    expect([bare.nodeExe, bare.hcExe]).toEqual(['node', 'hc']);
    expect(existsSync(bare.coreCwd)).toBe(true);
  });
});
