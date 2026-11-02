import { describe, expect, it, vi } from 'vitest';
import { closeWindowSessions, reconcileSessionOwners } from '../../electron/window-session-close';

describe('secondary window session close', () => {
  it('waits for every removal before closing the window', async () => {
    let resolve!: () => void;
    const removed = new Promise<void>((done) => {
      resolve = done;
    });
    const close = vi.fn();
    const pending = closeWindowSessions({
      sessionIds: ['a'],
      remove: () => removed,
      close,
      failed: vi.fn(),
    });
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    resolve();
    await pending;
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the window open and reports a failed removal', async () => {
    const close = vi.fn();
    const failed = vi.fn();
    await closeWindowSessions({
      sessionIds: ['a'],
      remove: async () => {
        throw new Error('connection wait expired');
      },
      close,
      failed,
    });
    expect(close).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith('connection wait expired');
  });
});

describe('snapshot session ownership', () => {
  it('repairs a vanished owner even when the session already exists', () => {
    const owners = new Map([
      ['a', 2],
      ['b', 1],
      ['pending', 2],
    ]);
    expect(
      reconcileSessionOwners(
        owners,
        ['a', 'b', 'pending'],
        (id) => id === 1 || id === 3,
        3,
        (id) => id === 'pending',
      ),
    ).toBe(true);
    expect([...owners]).toEqual([
      ['a', 3],
      ['b', 1],
      ['pending', 2],
    ]);
  });

  it('assigns new sessions to the primary fallback while retaining live owners', () => {
    const owners = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    reconcileSessionOwners(
      owners,
      ['a', 'b', 'c'],
      (id) => id === 1,
      1,
      () => false,
    );
    expect([...owners]).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
  });
});
