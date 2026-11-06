import { describe, expect, it } from 'vitest';
import { createSessionWaits, type WaitCondition } from '../../src/conduit-mcp/session-waits';

/** A fake host: each session's run counter is set by the test; reads never fail. */
function rig() {
  const completions = new Map<string, number>();
  const waits = createSessionWaits({
    read: (_callerHandle, target) => ({
      sessionId: target.sessionId,
      handle: target.handle,
      presence: 'idle',
      needsYou: false,
      unreadFrom: 0,
      completions: completions.get(target.sessionId) ?? 0,
    }),
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  const open = (until: WaitCondition[] = ['turn_end'], caller = 'fake-1', session = 's2') =>
    waits.open({
      caller: { sessionId: 's1', handle: caller },
      key: { connId: 1, requestId: 1 },
      targets: [{ sessionId: session, handle: 'fake-2' }],
      until,
      timeoutMs: 1000,
    });
  /** The wait's outcome if it has already settled, else 'pending'. Never waits on a timer. */
  const settled = (p: Promise<unknown>) => Promise.race([p, Promise.resolve('pending')]);
  return { waits, completions, open, settled };
}

describe('session waits: turn-end memo', () => {
  it('first wait counts a turn end that finished before the call', async () => {
    const { completions, open, settled } = rig();
    completions.set('s2', 1);
    expect(await settled(open())).toEqual({
      fired: [{ session: 'fake-2', condition: 'turn_end' }],
      timed_out: false,
      states: [{ session: 'fake-2', presence: 'idle', needs_you: false, unread_from: 0 }],
    });
  });

  it('a run counter that resets rebases the memo, so the next turn end counts', async () => {
    const { completions, waits, open, settled } = rig();
    completions.set('s2', 5);
    await open();
    completions.set('s2', 0);
    const pending = open();
    expect(await settled(pending)).toBe('pending');
    completions.set('s2', 1);
    waits.notify();
    expect(await settled(pending)).toMatchObject({
      fired: [{ session: 'fake-2', condition: 'turn_end' }],
    });
  });

  it('forgetting a session drops its memo as a target', async () => {
    const { completions, waits, open, settled } = rig();
    completions.set('s2', 1);
    await open();
    waits.forget('s2', undefined);
    expect(await settled(open())).toMatchObject({ fired: [{ condition: 'turn_end' }] });
  });

  it('forgetting a caller drops its memo for every session', async () => {
    const { completions, waits, open, settled } = rig();
    completions.set('s2', 1);
    await open();
    waits.forget('s9', 'fake-1');
    expect(await settled(open())).toMatchObject({ fired: [{ condition: 'turn_end' }] });
  });

  it('forgetting another caller keeps this caller memo', async () => {
    const { completions, waits, open, settled } = rig();
    completions.set('s2', 1);
    await open();
    waits.forget('s9', 'fake-7');
    expect(await settled(open())).toBe('pending');
  });
});
