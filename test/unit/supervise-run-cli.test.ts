import { describe, expect, it, vi } from 'vitest';
import { runCliWith } from '../../server/supervise';
import type { SuperviseOptions, TrayRelay } from '../../server/tray/contracts';

describe('supervisor CLI tray wiring', () => {
  it('creates a relay and finishes it with the supervision result', async () => {
    const exit = { reason: 'done' } as const;
    const finish = vi.fn(async () => {});
    const relay: TrayRelay = {
      hooks: { phase: vi.fn(), childExit: vi.fn() },
      stopSignal: new AbortController().signal,
      attachServer: vi.fn(),
      finish,
    };
    const createRelay = vi.fn(() => relay);
    const supervise = vi.fn(async (_options: SuperviseOptions) => exit);
    await runCliWith({
      argv: ['--user-data', '/u', '--tray', '/tray.exe'],
      platform: 'win32',
      createRelay,
      supervise,
    });
    expect(createRelay).toHaveBeenCalledOnce();
    expect(supervise.mock.calls[0][0]).toMatchObject({
      hooks: relay.hooks,
      stopSignal: relay.stopSignal,
    });
    expect(finish).toHaveBeenCalledWith(exit);
  });

  it.each([
    { argv: ['--user-data', '/u'], platform: 'win32' as const },
    { argv: ['--user-data', '/u', '--tray', '/tray.exe'], platform: 'linux' as const },
  ])('does not create a relay without a Windows tray', async ({ argv, platform }) => {
    const createRelay = vi.fn();
    const supervise = vi.fn(async () => ({ reason: 'done' }) as const);
    await runCliWith({ argv, platform, createRelay, supervise });
    expect(createRelay).not.toHaveBeenCalled();
    expect(supervise).toHaveBeenCalledOnce();
  });
});
