import { describe, expect, it } from 'vitest';
import { assignHandle, createSessionRegistry } from '../../src/conduit-mcp/session-registry';

describe('createSessionRegistry', () => {
  it('mint replaces the previous token', () => {
    const r = createSessionRegistry();
    r.mint('s1', 'tok-a');
    r.mint('s1', 'tok-b');
    expect(r.resolve('tok-a')).toBeNull();
    expect(r.resolve('tok-b')).toBe('s1');
  });

  it('tokens of different sessions are independent', () => {
    const r = createSessionRegistry();
    r.mint('s1', 'tok-a');
    r.mint('s2', 'tok-b');
    r.revoke('s1');
    expect(r.resolve('tok-b')).toBe('s2');
  });

  it('revoke → resolve null', () => {
    const r = createSessionRegistry();
    r.mint('s1', 'tok-a');
    r.revoke('s1');
    expect(r.resolve('tok-a')).toBeNull();
  });

  it('resolve(null) → null; an unknown token → null', () => {
    const r = createSessionRegistry();
    expect(r.resolve(null)).toBeNull();
    expect(r.resolve('nope')).toBeNull();
  });

  it('isLive only after connect; false after the last disconnect', () => {
    const r = createSessionRegistry();
    expect(r.isLive('s1')).toBe(false);
    r.connect(1, 's1');
    r.connect(2, 's1');
    expect(r.isLive('s1')).toBe(true);
    r.disconnect(1);
    expect(r.isLive('s1')).toBe(true);
    r.disconnect(2);
    expect(r.isLive('s1')).toBe(false);
  });

  it('connectionsOf lists ids, and revoke leaves them for the host to close', () => {
    const r = createSessionRegistry();
    r.mint('s1', 't');
    r.connect(3, 's1');
    r.connect(1, 's1');
    r.connect(2, 's2');
    expect(r.connectionsOf('s1')).toEqual([1, 3]);
    r.revoke('s1');
    expect(r.connectionsOf('s1')).toEqual([1, 3]);
    expect(r.connectionsOf('s9')).toEqual([]);
  });
});

describe('assignHandle', () => {
  it('keeps current when free', () => {
    expect(
      assignHandle({
        current: 'claude-2',
        prefix: 'claude',
        takenByOthers: new Set(),
        counters: { claude: 5 },
      }),
    ).toEqual({ handle: 'claude-2', counters: { claude: 5 }, allocated: false });
  });

  it('reallocates when takenByOthers has it', () => {
    expect(
      assignHandle({
        current: 'claude-2',
        prefix: 'claude',
        takenByOthers: new Set(['claude-2']),
        counters: { claude: 5 },
      }),
    ).toEqual({ handle: 'claude-6', counters: { claude: 6 }, allocated: true });
  });

  it('allocates when current is undefined', () => {
    expect(
      assignHandle({ current: undefined, prefix: 'codex', takenByOthers: new Set(), counters: {} }),
    ).toEqual({ handle: 'codex-1', counters: { codex: 1 }, allocated: true });
  });

  it('skips numbers other sessions hold when the counters were lost', () => {
    expect(
      assignHandle({
        current: undefined,
        prefix: 'claude',
        takenByOthers: new Set(['claude-1', 'claude-2']),
        counters: {},
      }),
    ).toEqual({ handle: 'claude-3', counters: { claude: 3 }, allocated: true });
  });
});
