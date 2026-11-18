import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));

import { handleUpdaterError } from '../../electron/updater';

describe('handleUpdaterError', () => {
  it('tells the user the .deb could not be installed and calls the notifier with the command', async () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    await handleUpdaterError(new Error('Command pkexec exited with code 127'), {
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

  it('keeps the plain error path for any other failure', async () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    await handleUpdaterError(new Error('net::ERR_CONNECTION_RESET'), {
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

it.each([
  ['success', vi.fn(async () => 'App Center'), /Click Install there/],
  ['no handler', vi.fn(async () => null), /couldn't install/],
  [
    'opening fails',
    vi.fn(async () => {
      throw new Error('desktop unavailable');
    }),
    /couldn't install/,
  ],
] as const)('handles system installer hand-off: %s', async (_name, openInstaller, message) => {
  const send = vi.fn();
  const downloadedFile = '/tmp/update.deb';
  await handleUpdaterError(new Error('Command pkexec exited with code 127'), {
    platform: 'linux',
    downloadedFile,
    openInstaller,
    send,
    onEvent: vi.fn(),
  });
  expect(openInstaller).toHaveBeenCalledWith(downloadedFile);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringMatching(message),
      command: "sudo apt install '/tmp/update.deb'",
    }),
  );
});
