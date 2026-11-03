import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  it('selects the packaged Windows tray source and disables it on other platforms', () => {
    const u = fresh();
    const input = { packaged: true, userData: u, appVersion: '1.2.3', appPath: u, env: {} };
    expect(runtimeLayout({ ...input, platform: 'win32' }).trayExe).toBe(
      join(u, 'runtime', '1.2.3', 'tray', 'conduit-tray.exe'),
    );
    for (const platform of ['darwin', 'linux'] as const)
      expect(runtimeLayout({ ...input, platform }).trayExe).toBeNull();
  });

  it('uses the dev build only when present, with an explicit override taking precedence', () => {
    const u = fresh();
    const input = {
      packaged: false,
      userData: u,
      appVersion: '1.2.3',
      appPath: u,
      env: {},
      platform: 'win32' as const,
    };
    expect(runtimeLayout(input).trayExe).toBeNull();
    const built = join(u, 'build', 'vendor', 'tray', 'conduit-tray.exe');
    mkdirSync(join(built, '..'), { recursive: true });
    writeFileSync(built, 'helper');
    expect(runtimeLayout(input).trayExe).toBe(built);
    const env = { CONDUIT_TRAY_BINARY: '/custom/tray.exe' };
    expect(runtimeLayout({ ...input, env }).trayExe).toBe('/custom/tray.exe');
    expect(runtimeLayout({ ...input, env, platform: 'linux' }).trayExe).toBeNull();
  });

  it('packaged paths are the ones prepareRuntime produces', async () => {
    const u = fresh();
    const layout = runtimeLayout({
      packaged: true,
      userData: u,
      appVersion: '0.52.0',
      appPath: '/ignored',
      env: { CONDUIT_NODE_BINARY: '/dev/node', CONDUIT_HC_BINARY: '/dev/hc' },
      platform: 'win32',
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
      trayExe: prepared.trayExe,
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
      trayExe: null,
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

  it('unpackaged node is the first one on PATH, absolute, so hc never picks its spelling', () => {
    const u = fresh();
    const bin = join(u, 'bin');
    mkdirSync(bin);
    const exe = join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
    writeFileSync(exe, '');
    const layout = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath: join(u, 'repo'),
      env: { Path: [join(u, 'missing'), bin].join(delimiter) },
    });
    expect(layout.nodeExe).toBe(exe);
  });

  it('unpackaged hc is the first one on PATH, absolute: an hc terminal never sees our PATH', () => {
    const u = fresh();
    const bin = join(u, 'bin');
    mkdirSync(bin);
    const exe = join(bin, process.platform === 'win32' ? 'hc.exe' : 'hc');
    writeFileSync(exe, '');
    const layout = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath: join(u, 'repo'),
      env: { Path: [join(u, 'missing'), bin].join(delimiter) },
    });
    expect(layout.hcExe).toBe(exe);
  });
});
