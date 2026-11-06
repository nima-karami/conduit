import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runCliWith, supervise } from '../../server/supervise';
import type { SuperviseOptions, TrayRelay } from '../../server/tray/contracts';
import { SERVER_EXIT } from '../../src/contracts/session-identity';

const spawn = vi.hoisted(() => {
  const impl = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(() => true),
      pid: 1,
    });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  return impl;
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

function trayRelay(): TrayRelay & { finish: ReturnType<typeof vi.fn> } {
  const finish = vi.fn(async () => {});
  return {
    hooks: { phase: vi.fn(), childExit: vi.fn() },
    stopSignal: new AbortController().signal,
    attachServer: vi.fn(),
    finish,
  };
}

describe('supervisor CLI tray wiring', () => {
  it('creates a relay, attaches the server child, and finishes with the supervision result', async () => {
    const exit = { reason: 'done' } as const;
    const relay = trayRelay();
    const createRelay = vi.fn(() => relay);
    const supervise = vi.fn(async (options: SuperviseOptions) => {
      await options.spawnChild();
      return exit;
    });
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
    expect(relay.attachServer).toHaveBeenCalledOnce();
    const child = spawn.mock.results[0]?.value as { send: ReturnType<typeof vi.fn> };
    const channel = vi.mocked(relay.attachServer).mock.calls[0][0];
    channel.send({ type: 'stopAll', id: 7 });
    expect(child.send).toHaveBeenCalledWith({ type: 'stopAll', id: 7 });
    expect(relay.finish).toHaveBeenCalledWith(exit);
  });

  it.each([
    { argv: ['--user-data', '/u'], platform: 'win32' as const },
    { argv: ['--user-data', '/u', '--tray', '/tray.exe'], platform: 'linux' as const },
  ])('does not create a relay without a Windows tray', async ({ argv, platform }) => {
    const createRelay = vi.fn();
    const supervise = vi.fn(async (_options: SuperviseOptions) => ({ reason: 'done' }) as const);
    await runCliWith({ argv, platform, createRelay, supervise });
    expect(createRelay).not.toHaveBeenCalled();
    expect(supervise).toHaveBeenCalledOnce();
    const opts = supervise.mock.calls[0][0];
    expect(opts).not.toHaveProperty('stopSignal');
    expect(opts).not.toHaveProperty('hooks');
    expect(opts).not.toHaveProperty('stopSessions');
  });

  it('tells the helper to exit before a last-core stop that never returns', async () => {
    const relay = trayRelay();
    const order: string[] = [];
    relay.finish.mockImplementation(async () => {
      order.push('finish');
    });
    void runCliWith({
      argv: ['--user-data', '/u', '--tray', '/tray.exe'],
      platform: 'win32',
      createRelay: () => relay,
      supervise: (options) =>
        supervise({
          ...options,
          spawnChild: async () => SERVER_EXIT.doneCoreIdle,
          core: {
            hasOtherLiveTerminals: async () => false,
            stop: () => {
              order.push('stopCore');
              return new Promise(() => {});
            },
          },
        }),
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(['finish', 'stopCore']);
    expect(relay.finish).toHaveBeenCalledWith({ reason: 'doneCoreIdle' });
  });

  it('finishes the relay when supervise throws, then propagates', async () => {
    const relay = trayRelay();
    const error = new Error('core stop failed');
    await expect(
      runCliWith({
        argv: ['--user-data', '/u', '--tray', '/tray.exe'],
        platform: 'win32',
        createRelay: () => relay,
        supervise: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(relay.finish).toHaveBeenCalledWith({ reason: 'done' });
  });
});
