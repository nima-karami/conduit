import { afterEach, describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn(),
}));
vi.mock('node:fs', () => ({ existsSync: () => true }));
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
      updater.logger.info('Executing: pkexec with args: ...');
      updater.logger.error('authentication failed');
      handlers.error(new Error('Command pkexec exited with code 127'));
    });
    quitAndInstall();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(onEvent).toHaveBeenCalledWith(
      'deb-install-diagnostic',
      expect.objectContaining({
        exitCode: 127,
        stderr: 'authentication failed',
        focused: true,
        visible: true,
        version: '1',
        fileExists: true,
        ageSeconds: expect.any(Number),
        environment: expect.objectContaining({ DISPLAY: expect.any(Boolean) }),
      }),
    );
    handlers['update-downloaded']({ version: '2', downloadedFile: '/tmp/next.deb' });
    expect(updater.autoInstallOnAppQuit).toBe(true);
    stop();
  });
});
