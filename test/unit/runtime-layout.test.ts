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

  it('unpackaged Windows prefers vendored hc over a different hc on PATH', () => {
    const u = fresh();
    const appPath = join(u, 'repo');
    const vendorExe = join(appPath, 'build', 'vendor', 'hc', 'hc.exe');
    const bin = join(u, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, process.platform === 'win32' ? 'hc.exe' : 'hc'), '');
    const layout = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath,
      env: { Path: bin },
      platform: 'win32',
      exists: (file) => file === vendorExe,
    });
    expect(layout.hcExe).toBe(vendorExe);
  });

  it('an explicit hc override wins over the Windows vendor and PATH', () => {
    const u = fresh();
    const appPath = join(u, 'repo');
    const vendorExe = join(appPath, 'build', 'vendor', 'hc', 'hc.exe');
    const overrideExe = join(u, 'override', 'hc.exe');
    const bin = join(u, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, process.platform === 'win32' ? 'hc.exe' : 'hc'), '');
    const layout = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath,
      env: { CONDUIT_HC_BINARY: overrideExe, Path: bin },
      platform: 'win32',
      exists: (file) => file === vendorExe,
    });
    expect(layout.hcExe).toBe(overrideExe);
  });

  it('unpackaged hc falls back to the first PATH executable when the Windows vendor is absent', () => {
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
      platform: 'win32',
      exists: () => false,
    });
    expect(layout.hcExe).toBe(exe);
  });

  it.each(['linux', 'darwin'] as const)(
    'unpackaged %s ignores the Windows vendor and uses PATH',
    (platform) => {
      const u = fresh();
      const appPath = join(u, 'repo');
      const vendorExe = join(appPath, 'build', 'vendor', 'hc', 'hc.exe');
      const bin = join(u, 'bin');
      mkdirSync(bin);
      const exe = join(bin, process.platform === 'win32' ? 'hc.exe' : 'hc');
      writeFileSync(exe, '');
      const layout = runtimeLayout({
        packaged: false,
        userData: u,
        appVersion: '0.52.0',
        appPath,
        env: { Path: bin },
        platform,
        exists: (file) => file === vendorExe,
      });
      expect(layout.hcExe).toBe(exe);
    },
  );
});
