import { describe, expect, it } from 'vitest';
import { createPresenceMirror } from '../../server/mcp/presence';
import type { WindowPresence } from '../../src/contracts/server-protocol';

const win = (windowId: number, over: Partial<WindowPresence> = {}): WindowPresence => ({
  windowId,
  focused: false,
  ready: true,
  visibleSessionIds: [],
  ownedSessionIds: [],
  ...over,
});

function mirror() {
  const calls: string[] = [];
  const m = createPresenceMirror({
    attention: {
      setVisible: (w, ids) => {
        calls.push(`visible ${w} [${ids.join(',')}]`);
        return false;
      },
      dropWindow: (w) => {
        calls.push(`drop ${w}`);
      },
      clearAll: () => {
        calls.push('clearAll');
      },
    },
    onSessionMoved: (s) => calls.push(`moved ${s}`),
    onWindowReset: (w) => calls.push(`reset ${w}`),
  });
  return { m, calls };
}

describe('presence mirror (F7, C2 WindowPresence)', () => {
  it('namespaces window ids per C2 connection', () => {
    const { m } = mirror();
    const a = {};
    const b = {};
    m.update(a, [win(1, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] })]);
    m.update(b, [win(1, { ownedSessionIds: ['s2'], ready: false })]);
    const wa = m.ownerWindowOf('s1');
    const wb = m.ownerWindowOf('s2');
    expect(wa).not.toBeNull();
    expect(wb).not.toBeNull();
    expect(wa).not.toBe(wb);
    expect(m.windowReady(wa ?? -1)).toBe(true);
    expect(m.windowReady(wb ?? -1)).toBe(false);
    expect(m.onScreen(wa ?? -1, 's1')).toBe(true);
    expect(m.onScreen(wb ?? -1, 's2')).toBe(false);
    expect(m.localOf(wa ?? -1)).toEqual({ conn: a, windowId: 1 });
    expect(m.localOf(wb ?? -1)).toEqual({ conn: b, windowId: 1 });
    expect(m.globalOf(a, 1)).toBe(wa);
  });

  it('fails closed for an unknown session or window', () => {
    const { m } = mirror();
    expect(m.ownerWindowOf('nope')).toBeNull();
    expect(m.windowReady(99)).toBe(false);
    expect(m.onScreen(99, 's1')).toBe(false);
  });

  it('forwards each presence to AttentionPort under the namespaced id', () => {
    const { m, calls } = mirror();
    const a = {};
    m.update(a, [win(3, { visibleSessionIds: ['s1', 's2'] })]);
    const g = m.globalOf(a, 3);
    expect(calls).toEqual([`visible ${g} [s1,s2]`]);
  });

  it('a window that disappears is dropped and reset; ready → not ready resets it', () => {
    const { m, calls } = mirror();
    const a = {};
    m.update(a, [win(1), win(2)]);
    const g1 = m.globalOf(a, 1);
    const g2 = m.globalOf(a, 2);
    calls.length = 0;
    m.update(a, [win(1, { ready: false })]);
    expect(calls).toContain(`drop ${g2}`);
    expect(calls).toContain(`reset ${g2}`);
    expect(calls).toContain(`reset ${g1}`);
    calls.length = 0;
    // Still not ready: no second reset.
    m.update(a, [win(1, { ready: false })]);
    expect(calls.filter((c) => c.startsWith('reset'))).toEqual([]);
  });

  it('onSessionMoved fires when a session changes owner between two updates', () => {
    const { m, calls } = mirror();
    const a = {};
    m.update(a, [win(1, { ownedSessionIds: ['s1', 's2'] }), win(2)]);
    calls.length = 0;
    m.update(a, [win(1, { ownedSessionIds: ['s2'] }), win(2, { ownedSessionIds: ['s1'] })]);
    expect(calls.filter((c) => c.startsWith('moved'))).toEqual(['moved s1']);
    expect(m.ownerWindowOf('s1')).toBe(m.globalOf(a, 2));
  });

  it('an app disconnect drops its windows, clears attention, and is not a reset or a move', () => {
    const { m, calls } = mirror();
    const a = {};
    m.update(a, [win(1, { ownedSessionIds: ['s1'] })]);
    const g = m.globalOf(a, 1);
    calls.length = 0;
    m.disconnect(a);
    expect(calls).toEqual([`drop ${g}`, 'clearAll']);
    expect(m.ownerWindowOf('s1')).toBeNull();
    // The reconnected app's window takes the session over without a move.
    const b = {};
    calls.length = 0;
    m.update(b, [win(1, { ownedSessionIds: ['s1'] })]);
    expect(calls.filter((c) => !c.startsWith('visible'))).toEqual([]);
    expect(m.ownerWindowOf('s1')).toBe(m.globalOf(b, 1));
    expect(m.ownerWindowOf('s1')).not.toBe(g);
  });

  it('clearAll waits for the last connection to go', () => {
    const { m, calls } = mirror();
    const a = {};
    const b = {};
    m.update(a, [win(1)]);
    m.update(b, [win(1)]);
    calls.length = 0;
    m.disconnect(a);
    expect(calls).not.toContain('clearAll');
    m.disconnect(b);
    expect(calls).toContain('clearAll');
  });
});
