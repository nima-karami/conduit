import { describe, expect, it, vi } from 'vitest';
import { stopAgentsBeforeQuit } from '../../electron/quit-stop';
import { stopAgentsFailureCopy } from '../../src/quit-guard';

describe('quit and stop failure decisions', () => {
  it('offers explicit retry, leave-running and cancel choices with the failure reason', () => {
    expect(stopAgentsFailureCopy('timeout')).toEqual({
      message: "Couldn't stop the agents: timeout",
      buttons: ['Retry', 'Quit and leave them running', 'Cancel'],
    });
  });

  it('cancels without quitting when stopAll fails', async () => {
    const finish = vi.fn();
    const cancel = vi.fn();
    const failure = vi.fn(async () => 'cancel' as const);
    await stopAgentsBeforeQuit({
      stop: async () => ({ ok: false, reason: 'timed out' }),
      failure,
      finish,
      cancel,
    });
    expect(finish).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith('timed out');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('retries a rejected stop and quits only after it succeeds', async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce({ ok: true });
    const finish = vi.fn();
    const failure = vi.fn(async () => 'retry' as const);
    await stopAgentsBeforeQuit({ stop, failure, finish, cancel: vi.fn() });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(failure).toHaveBeenCalledWith('disconnected');
    expect(finish).toHaveBeenCalledOnce();
  });

  it('allows explicitly quitting while leaving agents running', async () => {
    const finish = vi.fn();
    const failure = vi.fn(async () => 'leave' as const);
    await stopAgentsBeforeQuit({
      stop: async () => ({ ok: false }),
      failure,
      finish,
      cancel: vi.fn(),
    });
    expect(failure).toHaveBeenCalledWith('The background service is unavailable.');
    expect(finish).toHaveBeenCalledOnce();
  });
});
