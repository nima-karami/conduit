import { LINK_DEGRADED_MS, LINK_DOWN_MS, type LinkState } from '../contracts/link-protocol';

export interface LinkStateMachine {
  state: LinkState;
  since: number;
}

export type LinkEvent =
  | {
      kind: 'dial' | 'up' | 'frame' | 'closed' | 'incompatible' | 'identity-changed' | 'revoked';
      at: number;
    }
  | { kind: 'silence'; at: number; silentMs: number };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export function initialLinkState(at: number): LinkStateMachine {
  return { state: 'down', since: at };
}

export function linkEvent(s: LinkStateMachine, e: LinkEvent): LinkStateMachine {
  // revoked is the strongest verdict: it overrides incompatible and identity-changed, which
  // are otherwise terminal for this machine.
  if (s.state === 'revoked') return s;
  if (e.kind !== 'revoked' && (s.state === 'incompatible' || s.state === 'identity-changed')) {
    return s;
  }
  const next = nextState(s.state, e);
  return next === s.state ? s : { state: next, since: e.at };
}

function nextState(state: LinkState, e: LinkEvent): LinkState {
  switch (e.kind) {
    case 'dial':
      return state === 'down' ? 'connecting' : state;
    case 'up':
      return state === 'connecting' || state === 'down' || state === 'degraded' ? 'up' : state;
    case 'frame':
      return state === 'degraded' ? 'up' : state;
    case 'silence':
      if (state !== 'up' && state !== 'degraded') return state;
      if (e.silentMs >= LINK_DOWN_MS) return 'down';
      if (e.silentMs >= LINK_DEGRADED_MS) return 'degraded';
      return state;
    case 'closed':
      return state === 'connecting' || state === 'up' || state === 'degraded' ? 'down' : state;
    case 'incompatible':
    case 'identity-changed':
    case 'revoked':
      return e.kind;
  }
}

/** Exponential backoff from 1 s, capped at 60 s, with ±20 % jitter from `rand` in [0, 1). */
export function backoffMs(attempt: number, rand: () => number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/** When two links connect the same pair at once, both sides keep the one dialed by the lower id. */
export function keepConnection(
  a: { dialerMachineId: string },
  b: { dialerMachineId: string },
): 'a' | 'b' {
  return a.dialerMachineId <= b.dialerMachineId ? 'a' : 'b';
}
