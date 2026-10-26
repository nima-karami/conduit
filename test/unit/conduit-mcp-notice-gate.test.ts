import { describe, expect, it } from 'vitest';
import {
  awaitEnterVerdict,
  ECHO_POLL_MS,
  ECHO_WAIT_MS,
  type EnterRecheckInput,
  evaluateEnterRecheck,
  evaluateGate,
  type GateInput,
  type GateVerdict,
  IDLE_QUIET_MS,
  NOTICE_SPACING_MS,
} from '../../src/conduit-mcp/notice-gate';
import { composeNotice } from '../../src/conduit-mcp/notice-text';
import type { GateClosedReason } from '../../src/conduit-mcp/types';

const NOW = 1_000_000;
const SETTLE = 1_500;

const OPEN: GateInput = {
  now: NOW,
  settleMs: SETTLE,
  messagingOn: true,
  paused: false,
  running: true,
  spawnedAt: NOW - SETTLE,
  connectionLive: true,
  busy: false,
  lastOutputAt: NOW - IDLE_QUIET_MS,
  screen: 'empty-input',
  hasDraft: false,
  lastNoticeAt: NOW - NOTICE_SPACING_MS,
};

describe('evaluateGate', () => {
  it('the all-clear row is open', () => {
    expect(evaluateGate(OPEN)).toEqual({ open: true });
    expect(evaluateGate({ ...OPEN, lastOutputAt: undefined, lastNoticeAt: undefined })).toEqual({
      open: true,
    });
  });

  const closed: Array<[GateClosedReason, Partial<GateInput>]> = [
    ['off', { messagingOn: false }],
    ['paused', { paused: true }],
    ['not-running', { running: false }],
    ['settling', { spawnedAt: NOW - SETTLE + 1 }],
    ['settling', { spawnedAt: undefined }],
    ['no-connection', { connectionLive: false }],
    ['busy', { busy: true }],
    ['quiet', { lastOutputAt: NOW - 2_999 }],
    ['blocking-prompt', { screen: 'blocking' }],
    ['no-empty-input', { screen: 'unknown' }],
    ['no-empty-input', { screen: 'notice-echoed' }],
    ['draft', { hasDraft: true }],
    ['spacing', { lastNoticeAt: NOW - 29_999 }],
  ];
  it.each(closed)('closed: %s', (reason, flip) => {
    expect(evaluateGate({ ...OPEN, ...flip })).toEqual({ open: false, reason });
  });

  it('precedence follows the declared order', () => {
    const everything: GateInput = {
      ...OPEN,
      messagingOn: false,
      paused: true,
      running: false,
      spawnedAt: undefined,
      connectionLive: false,
      busy: true,
      lastOutputAt: NOW,
      screen: 'blocking',
      hasDraft: true,
      lastNoticeAt: NOW,
    };
    const order: Array<[GateClosedReason, Partial<GateInput>]> = [
      ['off', {}],
      ['paused', { messagingOn: true }],
      ['not-running', { paused: false }],
      ['settling', { running: true }],
      ['no-connection', { spawnedAt: NOW - SETTLE }],
      ['busy', { connectionLive: true }],
      ['quiet', { busy: false }],
      ['blocking-prompt', { lastOutputAt: undefined }],
      ['no-empty-input', { screen: 'unknown' }],
      ['draft', { screen: 'empty-input' }],
      ['spacing', { hasDraft: false }],
    ];
    let input = everything;
    for (const [reason, fix] of order) {
      input = { ...input, ...fix };
      expect(evaluateGate(input)).toEqual({ open: false, reason });
    }
  });
});

describe('evaluateEnterRecheck', () => {
  const RE: EnterRecheckInput = {
    messagingOn: true,
    paused: false,
    running: true,
    sameGeneration: true,
    connectionLive: true,
    screen: 'notice-echoed',
    inputSinceText: false,
  };
  const rows: Array<[string, Partial<EnterRecheckInput>, GateClosedReason | 'open']> = [
    ['notice-echoed', {}, 'open'],
    ['empty-input', { screen: 'empty-input' }, 'no-echo'],
    ['unknown', { screen: 'unknown' }, 'no-echo'],
    ['blocking', { screen: 'blocking' }, 'blocking-prompt'],
    ['inputSinceText', { inputSinceText: true }, 'draft'],
    ['!sameGeneration', { sameGeneration: false }, 'not-running'],
    ['!running', { running: false }, 'not-running'],
    ['off', { messagingOn: false }, 'off'],
    ['paused', { paused: true }, 'paused'],
    ['no connection', { connectionLive: false }, 'no-connection'],
    ['draft beats blocking', { inputSinceText: true, screen: 'blocking' }, 'draft'],
    ['off beats everything', { messagingOn: false, paused: true, running: false }, 'off'],
  ];
  it.each(rows)('%s', (_label, flip, want) => {
    expect(evaluateEnterRecheck({ ...RE, ...flip })).toEqual(
      want === 'open' ? { open: true } : { open: false, reason: want },
    );
  });
});

describe('awaitEnterVerdict', () => {
  const closedBy = (reason: GateClosedReason) => ({ open: false as const, reason });
  function clock() {
    const c = { t: 0, sleeps: [] as number[] };
    return {
      c,
      deps: {
        now: () => c.t,
        sleep: async (ms: number) => {
          c.sleeps.push(ms);
          c.t += ms;
        },
      },
    };
  }

  it('waits out a late echo (Codex renders typed text ~200–350 ms after it arrives)', async () => {
    const { c, deps } = clock();
    const seq: GateVerdict[] = [
      closedBy('no-echo'),
      closedBy('no-echo'),
      closedBy('no-echo'),
      { open: true },
    ];
    const r = await awaitEnterVerdict(async () => seq.shift() ?? closedBy('no-echo'), deps);
    expect(r).toEqual({ verdict: { open: true }, waitedMs: 3 * ECHO_POLL_MS });
    expect(c.sleeps).toEqual([ECHO_POLL_MS, ECHO_POLL_MS, ECHO_POLL_MS]);
  });

  it('gives up at ECHO_WAIT_MS with no-echo', async () => {
    const { c, deps } = clock();
    const r = await awaitEnterVerdict(async () => closedBy('no-echo'), deps);
    expect(r.verdict).toEqual(closedBy('no-echo'));
    expect(r.waitedMs).toBeGreaterThanOrEqual(ECHO_WAIT_MS);
    expect(c.t).toBeLessThan(ECHO_WAIT_MS + ECHO_POLL_MS);
  });

  it.each(['draft', 'blocking-prompt', 'not-running', 'no-connection', 'off', 'paused'] as const)(
    'a %s closure ends the wait at once',
    async (reason) => {
      const { c, deps } = clock();
      const seq = [closedBy('no-echo'), closedBy(reason)];
      const r = await awaitEnterVerdict(async () => seq.shift() ?? closedBy('no-echo'), deps);
      expect(r).toEqual({ verdict: closedBy(reason), waitedMs: ECHO_POLL_MS });
      expect(c.sleeps).toHaveLength(1);
    },
  );
});

describe('composeNotice', () => {
  it('composeNotice is ASCII with no digits', () => {
    for (const urgent of [true, false]) {
      const n = composeNotice(urgent);
      expect(n).toMatch(/^[\x20-\x7e]+$/);
      expect(n).not.toMatch(/\d/);
    }
    expect(composeNotice(true)).toBe(
      '[conduit] New messages for you (urgent). Use the conduit read_inbox tool.',
    );
    expect(composeNotice(false)).toBe(
      '[conduit] New messages for you. Use the conduit read_inbox tool.',
    );
    expect(composeNotice(false)).not.toContain('(urgent)');
  });
});
