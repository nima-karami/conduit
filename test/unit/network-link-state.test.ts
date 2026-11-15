import { describe, expect, it } from 'vitest';
import { LINK_DEGRADED_MS, LINK_DOWN_MS } from '../../src/contracts/link-protocol';
import {
  backoffMs,
  initialLinkState,
  keepConnection,
  type LinkEvent,
  type LinkStateMachine,
  linkEvent,
} from '../../src/network/link-state';

const AT = 1_000;
const LATER = 5_000;

function in_(state: LinkStateMachine['state']): LinkStateMachine {
  return { state, since: 0 };
}

function at(kind: Exclude<LinkEvent['kind'], 'silence'>, t = LATER): LinkEvent {
  return { kind, at: t };
}

describe('initialLinkState', () => {
  it('starts down, since the given time', () => {
    expect(initialLinkState(AT)).toEqual({ state: 'down', since: AT });
  });
});

describe('linkEvent transitions', () => {
  it('dial moves down to connecting and stamps since', () => {
    expect(linkEvent(in_('down'), at('dial'))).toEqual({ state: 'connecting', since: LATER });
  });

  it('dial from any other state leaves the object unchanged', () => {
    for (const s of ['connecting', 'up', 'degraded'] as const) {
      const before = in_(s);
      expect(linkEvent(before, at('dial'))).toBe(before);
    }
  });

  it('up moves connecting, down and degraded to up', () => {
    for (const s of ['connecting', 'down', 'degraded'] as const) {
      expect(linkEvent(in_(s), at('up'))).toEqual({ state: 'up', since: LATER });
    }
  });

  it('up from up is unchanged', () => {
    const before = in_('up');
    expect(linkEvent(before, at('up'))).toBe(before);
  });

  it('frame moves degraded to up', () => {
    expect(linkEvent(in_('degraded'), at('frame'))).toEqual({ state: 'up', since: LATER });
  });

  it('frame from other states is unchanged', () => {
    for (const s of ['down', 'connecting', 'up'] as const) {
      const before = in_(s);
      expect(linkEvent(before, at('frame'))).toBe(before);
    }
  });

  it('silence below the degraded threshold leaves up unchanged', () => {
    const before = in_('up');
    expect(linkEvent(before, { kind: 'silence', at: LATER, silentMs: LINK_DEGRADED_MS - 1 })).toBe(
      before,
    );
  });

  it('silence at the degraded threshold moves up to degraded', () => {
    expect(
      linkEvent(in_('up'), { kind: 'silence', at: LATER, silentMs: LINK_DEGRADED_MS }),
    ).toEqual({ state: 'degraded', since: LATER });
  });

  it('silence at the down threshold moves up or degraded to down', () => {
    for (const s of ['up', 'degraded'] as const) {
      expect(linkEvent(in_(s), { kind: 'silence', at: LATER, silentMs: LINK_DOWN_MS })).toEqual({
        state: 'down',
        since: LATER,
      });
    }
  });

  it('silence from down or connecting is unchanged', () => {
    for (const s of ['down', 'connecting'] as const) {
      const before = in_(s);
      expect(linkEvent(before, { kind: 'silence', at: LATER, silentMs: LINK_DOWN_MS })).toBe(
        before,
      );
    }
  });

  it('closed moves connecting, up and degraded to down', () => {
    for (const s of ['connecting', 'up', 'degraded'] as const) {
      expect(linkEvent(in_(s), at('closed'))).toEqual({ state: 'down', since: LATER });
    }
  });

  it('closed from down is unchanged', () => {
    const before = in_('down');
    expect(linkEvent(before, at('closed'))).toBe(before);
  });

  it('incompatible, identity-changed and revoked move any non-terminal state to that state', () => {
    for (const s of ['down', 'connecting', 'up', 'degraded'] as const) {
      expect(linkEvent(in_(s), at('incompatible'))).toEqual({
        state: 'incompatible',
        since: LATER,
      });
      expect(linkEvent(in_(s), at('identity-changed'))).toEqual({
        state: 'identity-changed',
        since: LATER,
      });
      expect(linkEvent(in_(s), at('revoked'))).toEqual({ state: 'revoked', since: LATER });
    }
  });

  it('revoked is terminal: every later event leaves it unchanged', () => {
    const revoked = in_('revoked');
    const events: LinkEvent[] = [
      at('dial'),
      at('up'),
      at('frame'),
      at('closed'),
      at('incompatible'),
      at('identity-changed'),
      { kind: 'silence', at: LATER, silentMs: LINK_DOWN_MS },
    ];
    for (const e of events) expect(linkEvent(revoked, e)).toBe(revoked);
  });

  it('incompatible is terminal except that revoked overrides it', () => {
    const inc = in_('incompatible');
    for (const e of [at('dial'), at('up'), at('closed'), at('identity-changed')]) {
      expect(linkEvent(inc, e)).toBe(inc);
    }
    expect(linkEvent(inc, at('revoked'))).toEqual({ state: 'revoked', since: LATER });
  });

  it('identity-changed is terminal except that revoked overrides it', () => {
    const idc = in_('identity-changed');
    for (const e of [at('dial'), at('up'), at('closed'), at('incompatible')]) {
      expect(linkEvent(idc, e)).toBe(idc);
    }
    expect(linkEvent(idc, at('revoked'))).toEqual({ state: 'revoked', since: LATER });
  });

  it('since is unchanged when the state does not change', () => {
    const up: LinkStateMachine = { state: 'up', since: AT };
    expect(linkEvent(up, at('up')).since).toBe(AT);
    expect(linkEvent(up, at('frame')).since).toBe(AT);
  });

  it('since is the event time when the state changes', () => {
    const down: LinkStateMachine = { state: 'down', since: AT };
    expect(linkEvent(down, at('dial', LATER)).since).toBe(LATER);
  });
});

describe('backoffMs', () => {
  it('attempt 0 is 800 to 1200 ms', () => {
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 0.999)).toBe(1200);
  });

  it('attempt 3 is 6400 to 9597 ms', () => {
    expect(backoffMs(3, () => 0)).toBe(6400);
    expect(backoffMs(3, () => 0.999)).toBe(9597);
  });

  it('attempt 10 is capped at 60 s before jitter: 48000 to 71976 ms', () => {
    expect(backoffMs(10, () => 0)).toBe(48_000);
    expect(backoffMs(10, () => 0.999)).toBe(71_976);
  });
});

describe('keepConnection', () => {
  it('keeps the connection dialed by the lower machine id, whichever side it is on', () => {
    const lo = { dialerMachineId: 'm-1111aaaa' };
    const hi = { dialerMachineId: 'm-2222bbbb' };
    expect(keepConnection(lo, hi)).toBe('a');
    expect(keepConnection(hi, lo)).toBe('b');
  });

  it('a tie keeps a', () => {
    const same = { dialerMachineId: 'm-1111aaaa' };
    expect(keepConnection(same, { ...same })).toBe('a');
  });
});
