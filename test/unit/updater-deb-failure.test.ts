import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));

import { handleUpdaterError } from '../../electron/updater';

describe('handleUpdaterError', () => {
  it('tells the user the .deb could not be installed and calls the notifier with the command', () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    handleUpdaterError(new Error('Command pkexec exited with code 127'), {
      platform: 'linux',
      downloadedFile: '/tmp/x y/conduit_1.2.3_amd64.deb',
      send,
      onEvent,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'updateStatus',
        status: 'error',
        command: "sudo apt install '/tmp/x y/conduit_1.2.3_amd64.deb'",
        message: expect.stringMatching(/couldn't install/i),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith('deb-install-failed', {
      command: "sudo apt install '/tmp/x y/conduit_1.2.3_amd64.deb'",
    });
  });

  it('keeps the plain error path for any other failure', () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    handleUpdaterError(new Error('net::ERR_CONNECTION_RESET'), {
      platform: 'linux',
      downloadedFile: '/tmp/conduit_1.2.3_amd64.deb',
      send,
      onEvent,
    });
    expect(send).toHaveBeenCalledWith({
      type: 'updateStatus',
      status: 'error',
      message: 'net::ERR_CONNECTION_RESET',
    });
    expect(onEvent).toHaveBeenCalledWith('error', { message: 'net::ERR_CONNECTION_RESET' });
  });
});
