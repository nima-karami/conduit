import { afterEach, describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({
  handler: 'snap-store_snap-store.desktop',
  openPath: vi.fn(async () => ''),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn(),
}));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readFileSync: () => '0::/user.slice/app-conduit-99.scope\n',
}));
vi.mock('node:child_process', () => ({
  spawnSync: (cmd: string) => ({
    status: 0,
    stdout: cmd.endsWith('/xdg-mime') ? updater.handler : '54\n',
  }),
}));
const electronUpdater = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  return new EventEmitter();
});
vi.mock('electron', () => ({
  app: { isPackaged: true },
  autoUpdater: electronUpdater,
  shell: { openPath: updater.openPath },
}));
vi.mock('electron-updater', () => ({ autoUpdater: updater }));
const relaunchApp = vi.hoisted(() => vi.fn());
vi.mock('../../electron/relaunch', () => ({ relaunchApp }));

import {
  cgroupScopeKind,
  initUpdater,
  installPlan,
  noNewPrivsFromStatus,
  quitAndInstall,
} from '../../electron/updater';

afterEach(() => vi.unstubAllGlobals());

describe('explicit deb install failure', () => {
  it('hands off the failed update and suppresses automatic retry until a different file downloads', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', resourcesPath: '/tmp' });
    const onEvent = vi.fn();
    const send = vi.fn();
    const stop = initUpdater(send, onEvent, () => ({ focused: true, visible: true }));
    const handlers = Object.fromEntries(
      updater.on.mock.calls.map(([event, handler]) => [event, handler]),
    );
    handlers['update-downloaded']({ version: '1', downloadedFile: '/tmp/update.deb' });
    expect(() => updater.logger.info({ message: 'diagnostic' })).not.toThrow();
    updater.quitAndInstall.mockImplementation(() => {
      updater.logger.info(
        "Executing: pkexec with args: --disable-internal-agent,/bin/bash,-c,'dpkg -i /tmp/update.deb'",
      );
      updater.logger.error('first failure');
      updater.logger.info(
        "Executing: pkexec with args: --disable-internal-agent,/bin/bash,-c,'apt-get install -f -y'",
      );
      updater.logger.error('authentication failed');
      handlers.error(new Error('Command pkexec exited with code 127'));
    });
    quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenLastCalledWith(true, false);
    expect(relaunchApp).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.openPath).toHaveBeenCalledWith('/tmp/update.deb');
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/Click Install there/),
        }),
      ),
    );
    expect(onEvent).toHaveBeenCalledWith(
      'deb-install-diagnostic',
      expect.objectContaining({
        exitCode: 127,
        pkexecAttempts: [
          { command: 'dpkg', stderr: 'first failure' },
          { command: 'apt-get', stderr: 'authentication failed' },
        ],
        scopeKind: 'app.scope',
        sessionId: '54',
        sessionLookup: 'found',
        focused: true,
        visible: true,
        version: '1',
        fileExists: true,
        ageSeconds: expect.any(Number),
        environment: expect.objectContaining({ DISPLAY: expect.any(Boolean) }),
      }),
    );
    updater.handler = 'org.gnome.FileRoller.desktop';
    updater.openPath.mockClear();
    quitAndInstall();
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/couldn't install/),
        }),
      ),
    );
    expect(updater.openPath).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith('deb-installer-open-failed', {
      reason: 'unrecognized-handler',
      desktopId: 'org.gnome.FileRoller.desktop',
    });
    handlers['update-downloaded']({ version: '1', downloadedFile: '/tmp/update.deb' });
    expect(updater.autoInstallOnAppQuit).toBe(false);
    handlers['update-downloaded']({ version: '2', downloadedFile: '/tmp/next.deb' });
    expect(updater.autoInstallOnAppQuit).toBe(true);
    stop();
  });
});

it.each(['linux', 'win32'])(
  'preserves automatic install after an unrelated failure on %s',
  (platform) => {
    vi.stubGlobal('process', { ...process, platform, resourcesPath: '/tmp' });
    updater.on.mockClear();
    const stop = initUpdater(vi.fn());
    try {
      const handlers = Object.fromEntries(updater.on.mock.calls);
      handlers['update-downloaded']({ version: '3', downloadedFile: '/tmp/pending.deb' });
      const error = () => handlers.error(new Error('net::ERR_CONNECTION_RESET'));
      if (platform === 'win32') {
        updater.quitAndInstall.mockImplementation(error);
        quitAndInstall();
      } else {
        error();
      }
      expect(updater.autoInstallOnAppQuit).toBe(true);
    } finally {
      stop();
    }
  },
);

it.each([
  ['0::/user.slice/session-54.scope', 'session.scope'],
  ['0::/user.slice/user@1000.service/app-conduit-99.scope', 'app.scope'],
  ['0::/user.slice/user@1000.service/vte-spawn-99.scope', 'terminal-or-other.scope'],
  ['0::/user.slice/user@1000.service/custom.scope', 'terminal-or-other.scope'],
  ['0::/system.slice/conduit.service', 'service'],
  ['0::/user.slice', 'other'],
  ['2:cpu:/user.slice\n1:name=systemd:/user.slice/session-54.scope', 'session.scope'],
])('classifies the cgroup leaf in %s', (line, kind) => {
  expect(cgroupScopeKind(line)).toBe(kind);
});

describe('install relaunch', () => {
  // Mirrors BaseUpdater.quitAndInstall: only an install that went through emits
  // before-quit-for-update (in a setImmediate); a repeat call is ignored without an error.
  function fakeBaseUpdater() {
    let called = false;
    updater.quitAndInstall.mockReset();
    updater.quitAndInstall.mockImplementation(() => {
      if (called) return;
      called = true;
      setImmediate(() => electronUpdater.emit('before-quit-for-update'));
    });
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('relaunches with the helper after a .deb install goes through, not via electron-updater', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', env: {}, resourcesPath: '/tmp' });
    fakeBaseUpdater();
    relaunchApp.mockClear();
    quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, false);
    await tick();
    expect(relaunchApp).toHaveBeenCalledOnce();
    expect(electronUpdater.listenerCount('before-quit-for-update')).toBe(0);
  });

  it('does not relaunch when a repeat Update click is ignored by electron-updater', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', env: {}, resourcesPath: '/tmp' });
    fakeBaseUpdater();
    quitAndInstall();
    await tick();
    relaunchApp.mockClear();
    quitAndInstall();
    await tick();
    expect(relaunchApp).not.toHaveBeenCalled();
    expect(electronUpdater.listenerCount('before-quit-for-update')).toBe(0);
    electronUpdater.emit('before-quit-for-update');
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it('does not relaunch on Windows, where electron-updater relaunches', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: {}, resourcesPath: '/tmp' });
    fakeBaseUpdater();
    relaunchApp.mockClear();
    quitAndInstall();
    await tick();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it.each([
    ['linux', {}, { forceRunAfter: false, relaunchOurselves: true }],
    ['linux', { APPIMAGE: '/a/C.AppImage' }, { forceRunAfter: true, relaunchOurselves: false }],
    ['win32', {}, { forceRunAfter: true, relaunchOurselves: false }],
  ])('plans %s %j', (platform, env, plan) => {
    expect(installPlan(platform, env)).toEqual(plan);
  });
});

describe('noNewPrivsFromStatus', () => {
  it('reads the flag from /proc status', () => {
    expect(noNewPrivsFromStatus('Name:\tconduit\nNoNewPrivs:\t1\nSeccomp:\t0\n')).toBe(true);
    expect(noNewPrivsFromStatus('NoNewPrivs:\t0\n')).toBe(false);
    expect(noNewPrivsFromStatus('Name:\tconduit\n')).toBeNull();
  });
});
