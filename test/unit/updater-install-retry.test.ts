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
vi.mock('electron', () => ({ app: { isPackaged: true }, shell: { openPath: updater.openPath } }));
vi.mock('electron-updater', () => ({ autoUpdater: updater }));

import { cgroupScopeKind, initUpdater, quitAndInstall } from '../../electron/updater';

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
