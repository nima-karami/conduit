import { describe, expect, it } from 'vitest';
import {
  DORMANT_MS,
  EVICT_MIN_HIDDEN_MS,
  HEAVY_LIVE_MAX,
  isDormant,
  isEvictable,
  LIVE_MAX,
  planEvictions,
  type ResidencyServer,
} from '../../src/lsp-residency';

const NOW = 10_000_000;

function srv(key: string, o: Partial<ResidencyServer> = {}): ResidencyServer {
  return {
    key,
    weight: 'heavy',
    state: 'ready',
    live: true,
    visible: false,
    hiddenSince: NOW - EVICT_MIN_HIDDEN_MS - 1,
    lastActivity: NOW - EVICT_MIN_HIDDEN_MS - 1,
    inFlight: 0,
    ...o,
  };
}

describe('residency caps', () => {
  it('caps are the settled D2 values', () => {
    expect([HEAVY_LIVE_MAX, LIVE_MAX, EVICT_MIN_HIDDEN_MS, DORMANT_MS]).toEqual([
      2, 4, 60_000, 600_000,
    ]);
  });
});

describe('isEvictable', () => {
  it('a live, hidden, idle, settled server hidden for 60 s is evictable', () => {
    expect(isEvictable(srv('a', { hiddenSince: NOW - EVICT_MIN_HIDDEN_MS }), NOW)).toBe(true);
  });

  it.each([
    ['visible', { visible: true }],
    ['in flight', { inFlight: 1 }],
    ['starting', { state: 'starting' as const }],
    ['loading', { state: 'loading' as const }],
    ['restarting after a crash', { state: 'restarting' as const }],
    ['hidden < 60 s', { hiddenSince: NOW - EVICT_MIN_HIDDEN_MS + 1 }],
    ['not live', { live: false }],
  ])('never evicts a server that is %s', (_label, o) => {
    expect(isEvictable(srv('a', o), NOW)).toBe(false);
  });
});

describe('planEvictions', () => {
  it('a third heavy evicts the least-recently-used evictable heavy', () => {
    const servers = [
      srv('rust', { lastActivity: NOW - 200_000 }),
      srv('cpp', { lastActivity: NOW - 100_000 }),
    ];
    expect(planEvictions({ key: 'cs', weight: 'heavy' }, servers, NOW)).toEqual({
      evict: ['rust'],
      overBudget: false,
    });
  });

  it('skips a non-evictable heavy and takes the next LRU one', () => {
    const servers = [
      srv('rust', { lastActivity: NOW - 200_000, inFlight: 2 }),
      srv('cpp', { lastActivity: NOW - 100_000 }),
    ];
    expect(planEvictions({ key: 'cs', weight: 'heavy' }, servers, NOW).evict).toEqual(['cpp']);
  });

  it('a light incoming never evicts for the heavy cap', () => {
    const servers = [srv('rust'), srv('cpp')];
    expect(planEvictions({ key: 'go', weight: 'light' }, servers, NOW)).toEqual({
      evict: [],
      overBudget: false,
    });
  });

  it('the total cap evicts the LRU of any weight after the heavy pass', () => {
    const servers = [
      srv('rust', { lastActivity: NOW - 100_000 }),
      srv('py', { weight: 'light', lastActivity: NOW - 300_000 }),
      srv('go', { weight: 'light', lastActivity: NOW - 50_000 }),
      srv('go2', { weight: 'light', lastActivity: NOW - 400_000, visible: true }),
    ];
    expect(planEvictions({ key: 'go3', weight: 'light' }, servers, NOW)).toEqual({
      evict: ['py'],
      overBudget: false,
    });
  });

  it('a heavy incoming over both caps evicts a heavy, which also clears the total cap', () => {
    const servers = [
      srv('rust', { lastActivity: NOW - 100_000 }),
      srv('cpp', { lastActivity: NOW - 50_000 }),
      srv('py', { weight: 'light', lastActivity: NOW - 300_000 }),
      srv('go', { weight: 'light', lastActivity: NOW - 400_000 }),
    ];
    expect(planEvictions({ key: 'cs', weight: 'heavy' }, servers, NOW)).toEqual({
      evict: ['rust'],
      overBudget: false,
    });
  });

  it('nothing evictable → no evictions, over budget (soft cap)', () => {
    const servers = [srv('rust', { visible: true }), srv('cpp', { state: 'loading' })];
    expect(planEvictions({ key: 'cs', weight: 'heavy' }, servers, NOW)).toEqual({
      evict: [],
      overBudget: true,
    });
  });

  it('ignores the incoming server when it is already in the list', () => {
    const servers = [srv('rust'), srv('cs', { live: true, state: 'starting' })];
    expect(planEvictions({ key: 'cs', weight: 'heavy' }, servers, NOW)).toEqual({
      evict: [],
      overBudget: false,
    });
  });

  it('records that hold no process never count toward a cap', () => {
    const servers = [
      srv('rust'),
      srv('cpp', { live: false, state: 'absent' }),
      srv('cpp2', { live: false, state: 'restricted' }),
      srv('cpp3', { live: false, state: 'stopped' }),
    ];
    expect(planEvictions({ key: 'cs', weight: 'heavy' }, servers, NOW)).toEqual({
      evict: [],
      overBudget: false,
    });
  });
});

describe('isDormant', () => {
  const base = { hiddenSince: NOW - DORMANT_MS - 5_000, lastActivity: NOW - DORMANT_MS };

  it('is true at exactly DORMANT_MS after the later of activity and hiding', () => {
    expect(isDormant(srv('a', base), NOW)).toBe(true);
    expect(isDormant(srv('a', base), NOW - 1)).toBe(false);
    expect(isDormant(srv('a', { ...base, hiddenSince: NOW - DORMANT_MS + 1 }), NOW)).toBe(false);
  });

  it.each([
    ['visible', { visible: true }],
    ['in flight', { inFlight: 1 }],
    ['starting', { state: 'starting' as const }],
    ['loading', { state: 'loading' as const }],
    ['restarting after a crash', { state: 'restarting' as const }],
    ['not live', { live: false }],
  ])('is false while %s', (_label, o) => {
    expect(isDormant(srv('a', { ...base, ...o }), NOW)).toBe(false);
  });
});
