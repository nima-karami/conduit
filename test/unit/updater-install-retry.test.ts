import { afterEach, describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({
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
vi.mock('node:child_process', () => ({ spawnSync: () => ({ status: 0, stdout: '54\n' }) }));
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('electron-updater', () => ({ autoUpdater: updater }));

import { initUpdater, quitAndInstall } from '../../electron/updater';

afterEach(() => vi.unstubAllGlobals());

describe('explicit deb install failure', () => {
  it('does not retry on later quit, while a new download restores install-on-quit', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', resourcesPath: '/tmp' });
    const onEvent = vi.fn();
    const stop = initUpdater(vi.fn(), onEvent, () => ({ focused: true, visible: true }));
    const handlers = Object.fromEntries(
      updater.on.mock.calls.map(([event, handler]) => [event, handler]),
    );
    handlers['update-downloaded']({ version: '1', downloadedFile: '/tmp/update.deb' });
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
        focused: true,
        visible: true,
        version: '1',
        fileExists: true,
        ageSeconds: expect.any(Number),
        environment: expect.objectContaining({ DISPLAY: expect.any(Boolean) }),
      }),
    );
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
