import { describe, expect, it } from 'vitest';
import type { RequestsUiState, RequestView } from '../../src/conduit-mcp/request-types';
import { awayLabel, awayUntil, digestCounts } from '../../webview/away-view-model';

const pad = (n: number) => String(n).padStart(2, '0');
const localHHMM = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const MIN = 60_000;
const HOUR = 60 * MIN;

function req(over: Partial<RequestView> = {}): RequestView {
  return {
    id: 'r1',
    origin: 'srv',
    source: 'agent',
    kind: 'confirm',
    requester: 'codex-4',
    session: 's1',
    space: 'sp1',
    lead: null,
    machine: 'laptop',
    title: 'Run tests?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    default: null,
    contentKey: 'k',
    state: 'open',
    endedAt: null,
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    permission: null,
    waiting: false,
    waitingUntil: null,
    ...over,
  };
}

const FROM = Date.parse('2026-11-14T00:31:00.000Z');
const TO = Date.parse('2026-11-14T09:12:00.000Z');
const WINDOW = { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() };

function ui(
  over: Partial<RequestsUiState> = {},
  lastAway: RequestsUiState['presence']['lastAway'] = WINDOW,
): RequestsUiState {
  return {
    open: [],
    ended: [],
    presence: { state: 'here', since: new Date(0).toISOString(), until: null, lastAway },
    ...over,
  };
}

const inside = (ms: number) => new Date(ms).toISOString();

describe('awayUntil', () => {
  it('For 1 hour is an hour from now', () => {
    const now = Date.parse('2026-11-14T10:20:00.000Z');
    expect(awayUntil('hour', now)).toBe(new Date(now + HOUR).toISOString());
  });

  it('Until 09:00 tomorrow is 09:00 local tomorrow, across midnight', () => {
    const late = new Date(2026, 10, 14, 23, 30).getTime();
    const until = awayUntil('tomorrow9', late);
    expect(until).not.toBeNull();
    expect(new Date(until as string).getTime()).toBe(new Date(2026, 10, 15, 9, 0, 0, 0).getTime());
    expect(awayLabel(until)).toBe('09:00');

    const early = new Date(2026, 10, 15, 0, 30).getTime();
    expect(new Date(awayUntil('tomorrow9', early) as string).getTime()).toBe(
      new Date(2026, 10, 16, 9, 0, 0, 0).getTime(),
    );
  });

  it("until I'm back has no end", () => {
    expect(awayUntil('untilBack', Date.now())).toBeNull();
  });
});

describe('awayLabel', () => {
  it('is local HH:MM, or empty for no end', () => {
    const d = new Date(2026, 10, 15, 9, 5);
    expect(awayLabel(d.toISOString())).toBe(localHHMM(d));
    expect(awayLabel(null)).toBe('');
  });
});

describe('digestCounts', () => {
  it('digest counts only requests ended inside the away window', () => {
    const inWindow = inside(FROM + HOUR);
    const edgeStart = inside(FROM);
    const edgeEnd = inside(TO);
    const before = inside(FROM - MIN);
    const after = inside(TO + MIN);
    const state = ui({
      open: [req({ id: 'o1' }), req({ id: 'o2', state: 'open' })],
      ended: [
        req({
          id: 'def',
          state: 'answered',
          endedAt: inWindow,
          answer: {
            outcome: 'chosen',
            answeredBy: { kind: 'default' },
            at: inWindow,
          },
        }),
        req({
          id: 'you',
          state: 'answered',
          endedAt: edgeStart,
          answer: {
            outcome: 'approved',
            answeredBy: { kind: 'you', windowId: 1 },
            at: edgeStart,
          },
        }),
        req({ id: 'exp', state: 'expired', endedAt: edgeEnd }),
        req({ id: 'res', state: 'resolved', endedAt: inWindow }),
        req({ id: 'old-exp', state: 'expired', endedAt: before }),
        req({ id: 'late-res', state: 'resolved', endedAt: after }),
        req({ id: 'no-end', state: 'resolved', endedAt: null }),
        req({ id: 'withdrawn', state: 'withdrawn', endedAt: inWindow }),
      ],
    });

    expect(digestCounts(state)).toEqual({
      from: WINDOW.from,
      to: WINDOW.to,
      durationLabel: '8 h 41 m',
      stillNeedYou: 2,
      wentWithDefault: 1,
      expired: 1,
      cleared: 1,
    });
  });

  it('no digest without a finished Away', () => {
    expect(digestCounts(ui({}, null))).toBeNull();
  });

  it('duration labels', () => {
    const start = Date.parse('2026-11-14T10:00:00.000Z');
    const label = (ms: number) =>
      digestCounts(ui({}, { from: inside(start), to: inside(start + ms) }))?.durationLabel;
    expect(label(45 * MIN)).toBe('45 m');
    expect(label(HOUR)).toBe('1 h 0 m');
    expect(label(8 * HOUR + 41 * MIN)).toBe('8 h 41 m');
  });
});
