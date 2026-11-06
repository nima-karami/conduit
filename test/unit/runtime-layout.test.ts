import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const coreCwd = (u: string) => join(u, 'runtime', 'conduit-hc', HC_PINNED_VERSION);

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
      env: { CONDUIT_HC_BINARY: '/hc' },
      platform: 'win32' as const,
    };
    expect(runtimeLayout(input).trayExe).toBeNull();
    const built = join(u, 'build', 'vendor', 'tray', 'conduit-tray.exe');
    mkdirSync(join(built, '..'), { recursive: true });
    writeFileSync(built, 'helper');
    expect(runtimeLayout(input).trayExe).toBe(built);
    const env = { CONDUIT_TRAY_BINARY: '/custom/tray.exe', CONDUIT_HC_BINARY: '/hc' };
    expect(runtimeLayout({ ...input, env }).trayExe).toBe('/custom/tray.exe');
    expect(runtimeLayout({ ...input, env, platform: 'linux' }).trayExe).toBeNull();
  });

  it.each(['win32', 'darwin'] as const)(
    'packaged %s paths match prepareRuntime',
    async (platform) => {
      const u = fresh();
      const layout = runtimeLayout({
        packaged: true,
        platform,
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
        platform,
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
        trayExe: platform === 'win32' ? prepared.trayExe : null,
      });
      expect(layout.nodeExe).toBe(
        join(u, 'runtime', '0.52.0', platform === 'win32' ? 'node.exe' : 'node'),
      );
      expect(layout.hcExe).toBe(
        join(coreCwd(u), platform === 'win32' ? 'conduit-hc.exe' : 'conduit-hc'),
      );
      expect(existsSync(layout.coreCwd)).toBe(true);
    },
  );

  it('unpackaged uses the build output and explicit overrides, never a user hc on PATH', () => {
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
      exists: () => true,
    });
    expect(bare.nodeExe).toBe('node');
    expect(bare.hcExe).toBe(
      join(
        appPath,
        'build',
        'vendor',
        'hc',
        process.platform === 'win32' ? 'conduit-hc.exe' : 'conduit-hc',
      ),
    );
    expect(existsSync(bare.coreCwd)).toBe(true);
  });

  it.each(['win32', 'darwin'] as const)('unpackaged %s node is the first on PATH', (platform) => {
    const u = fresh();
    const bin = '/bin';
    const exe = join(bin, platform === 'win32' ? 'node.exe' : 'node');
    const layout = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath: join(u, 'repo'),
      platform,
      exists: (file) =>
        file === exe ||
        file ===
          join(
            u,
            'repo',
            'build',
            'vendor',
            'hc',
            platform === 'win32' ? 'conduit-hc.exe' : 'conduit-hc',
          ),
      env: { PATH: [join(u, 'missing'), bin].join(platform === 'win32' ? ';' : ':') },
    });
    expect(layout.nodeExe).toBe(exe);
  });

  it('unpackaged Windows prefers vendored hc over a different hc on PATH', () => {
    const u = fresh();
    const appPath = join(u, 'repo');
    const vendorExe = join(appPath, 'build', 'vendor', 'hc', 'conduit-hc.exe');
    const bin = join(u, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'hc.exe'), '');
    const options = {
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath,
      env: { Path: bin },
      platform: 'win32' as const,
      exists: existsSync,
    };
    mkdirSync(join(vendorExe, '..'), { recursive: true });
    writeFileSync(vendorExe, 'pinned engine');
    const layout = runtimeLayout(options);
    expect(layout.hcExe).toBe(vendorExe);
    rmSync(vendorExe);
    expect(() => runtimeLayout(options)).toThrow(/run node build\/fetch-runtime\.mjs/);
  });

  it('an explicit hc override wins over the Windows vendor and PATH', () => {
    const u = fresh();
    const appPath = join(u, 'repo');
    const vendorExe = join(appPath, 'build', 'vendor', 'hc', 'conduit-hc.exe');
    const overrideExe = join(u, 'override', 'hc.exe');
    const bin = join(u, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'hc.exe'), '');
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

  it('a missing Windows vendor never selects the user hc executable on PATH', () => {
    const u = fresh();
    const bin = join(u, 'bin');
    mkdirSync(bin);
    const exe = join(bin, 'hc.exe');
    writeFileSync(exe, '');
    expect(() =>
      runtimeLayout({
        packaged: false,
        userData: u,
        appVersion: '0.52.0',
        appPath: join(u, 'repo'),
        env: { Path: [join(u, 'missing'), bin].join(';') },
        platform: 'win32',
        exists: existsSync,
      }),
    ).toThrow(/run node build\/fetch-runtime\.mjs/);
  });

  it('unpackaged Linux also keeps hc separate from the user executable on PATH', () => {
    const u = fresh();
    const appPath = join(u, 'repo');
    const vendorExe = join(appPath, 'build', 'vendor', 'hc', 'conduit-hc');
    const bin = '/bin';
    const exe = join(bin, 'hc');
    const layout = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath,
      env: { PATH: bin },
      platform: 'linux',
      exists: (file) => file === vendorExe || file === exe,
    });
    expect(layout.hcExe).toBe(vendorExe);
  });

  it('unpackaged macOS prefers its vendored hc over PATH', () => {
    const u = fresh();
    const appPath = join(u, 'repo');
    const vendorExe = join(appPath, 'build', 'vendor', 'hc', 'conduit-hc');
    const pathExe = join('/bin', 'hc');
    const layout = runtimeLayout({
      packaged: false,
      userData: u,
      appVersion: '0.52.0',
      appPath,
      env: { PATH: '/bin' },
      platform: 'darwin',
      exists: (file) => file === vendorExe || file === pathExe,
    });
    expect(layout.hcExe).toBe(vendorExe);
  });
});
