import { describe, expect, it } from 'vitest';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import {
  ageLabel,
  applyFilters,
  bodyLines,
  cardsOf,
  filterOptions,
  isConduit,
  NO_FILTERS,
  openAsOf,
  type SessionInfo,
  shortestWaiting,
  sortRequests,
  typeOf,
} from '../../webview/request-view-model';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;
const lines = (n: number): string => Array.from({ length: n }, () => 'a').join('\n');

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
    createdAt: iso(NOW - 5 * MIN),
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

const SESSIONS = new Map<string, SessionInfo>([
  ['s1', { name: 'Build', handle: 'codex-4' }],
  ['s2', { name: 'Docs', handle: 'claude-3' }],
  ['lead1', { name: 'Lead A', handle: 'lead-a' }],
]);
const SPACES = new Map<string, string>([
  ['sp1', 'Conduit'],
  ['sp2', 'Website'],
]);
const ctx = { now: NOW, sessions: SESSIONS, spaces: SPACES };

describe('typeOf', () => {
  it('maps confirm to approve', () => {
    expect(typeOf(req({ kind: 'confirm' }))).toBe('approve');
  });
  it('maps choose and text to answer', () => {
    expect(typeOf(req({ kind: 'choose' }))).toBe('answer');
    expect(typeOf(req({ kind: 'text' }))).toBe('answer');
  });
  it('maps review to review', () => {
    expect(typeOf(req({ kind: 'review' }))).toBe('review');
  });
  it('maps attend to approve only when blocked on permission', () => {
    expect(typeOf(req({ kind: 'attend', blocked: 'permission' }))).toBe('approve');
    expect(typeOf(req({ kind: 'attend', blocked: 'question' }))).toBe('answer');
    expect(typeOf(req({ kind: 'attend', blocked: 'auth' }))).toBe('answer');
    expect(typeOf(req({ kind: 'attend', blocked: null }))).toBe('answer');
  });
});

describe('isConduit', () => {
  it('is true for observed, scheduler and conduit-requested', () => {
    expect(isConduit(req({ source: 'observed' }))).toBe(true);
    expect(isConduit(req({ source: 'scheduler' }))).toBe(true);
    expect(isConduit(req({ requester: 'conduit' }))).toBe(true);
  });
  it('is false for an agent request', () => {
    expect(isConduit(req({ source: 'agent', requester: 'codex-4' }))).toBe(false);
    expect(isConduit(req({ source: 'message', requester: 'codex-4' }))).toBe(false);
  });
});

describe('openAsOf size rule', () => {
  it('opens review as a tab even when small', () => {
    expect(openAsOf(req({ kind: 'review', body: 'short' }))).toBe('tab');
  });
  it('opens attend in the terminal', () => {
    expect(openAsOf(req({ kind: 'attend', blocked: 'question' }))).toBe('terminal');
  });
  it('opens a small confirm as a popup', () => {
    expect(openAsOf(req({ kind: 'confirm', body: 'Run it?' }))).toBe('popup');
  });
  it('allows 600 body characters and rejects 601', () => {
    expect(openAsOf(req({ body: 'x'.repeat(600) }))).toBe('popup');
    expect(openAsOf(req({ body: 'x'.repeat(601) }))).toBe('tab');
  });
  it('allows 8 body lines and rejects 9', () => {
    expect(openAsOf(req({ body: lines(8) }))).toBe('popup');
    expect(openAsOf(req({ body: lines(9) }))).toBe('tab');
  });
  it('allows 4 options and rejects 5', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `o${i}` }));
    expect(openAsOf(req({ options: opts(4) }))).toBe('popup');
    expect(openAsOf(req({ options: opts(5) }))).toBe('tab');
  });
  it('allows a 100-character option description and rejects 101', () => {
    const desc = (n: number) => [{ label: 'o', description: 'd'.repeat(n) }];
    expect(openAsOf(req({ options: desc(100) }))).toBe('popup');
    expect(openAsOf(req({ options: desc(101) }))).toBe('tab');
  });
  it('counts an empty body as zero lines', () => {
    expect(bodyLines(req({ body: '' }))).toBe(0);
    expect(bodyLines(req({ body: 'a\nb' }))).toBe(2);
  });
});

describe('tabLines', () => {
  it('counts a review draft, ignoring a trailing newline', () => {
    const r = req({ kind: 'review', draft: 'a\nb\nc\n' });
    expect(cardsOf([r], ctx)[0]?.tabLines).toBe(3);
  });
  it('counts a null review draft as zero lines', () => {
    expect(cardsOf([req({ kind: 'review', draft: null })], ctx)[0]?.tabLines).toBe(0);
  });
  it('counts body lines for a long non-review tab', () => {
    const r = req({ body: 'x'.repeat(601) });
    expect(cardsOf([r], ctx)[0]?.tabLines).toBe(1);
  });
  it('is null for a popup', () => {
    expect(cardsOf([req({ body: 'short' })], ctx)[0]?.tabLines).toBeNull();
  });
});

describe('sortRequests soonest', () => {
  const waitingLate = req({
    id: 'E',
    waiting: true,
    waitingUntil: iso(NOW + 30_000),
    createdAt: iso(NOW - 1 * MIN),
  });
  const waitingSoon = req({
    id: 'F',
    waiting: true,
    waitingUntil: iso(NOW + 10_000),
    createdAt: iso(NOW - 1 * MIN),
  });
  const urgent = req({ id: 'B', priority: 'urgent', createdAt: iso(NOW - 1 * MIN) });
  const expiresSoon = req({
    id: 'C',
    expiresAt: iso(NOW + 5 * MIN),
    createdAt: iso(NOW - 3 * MIN),
  });
  const expiresLater = req({
    id: 'D',
    expiresAt: iso(NOW + 30 * MIN),
    createdAt: iso(NOW - 3 * MIN),
  });
  const oldPlain = req({ id: 'G', createdAt: iso(NOW - 20 * MIN) });
  const newPlain = req({ id: 'A', createdAt: iso(NOW - 10 * MIN) });

  it('orders waiting, then urgent, then nearest expiry, then oldest', () => {
    const input = [newPlain, expiresLater, urgent, waitingLate, oldPlain, expiresSoon, waitingSoon];
    const ids = sortRequests(input, 'soonest', SESSIONS).map((r) => r.id);
    expect(ids).toEqual(['F', 'E', 'B', 'C', 'D', 'G', 'A']);
  });

  it('does not mutate its input', () => {
    const input = [newPlain, waitingSoon];
    const before = input.map((r) => r.id);
    sortRequests(input, 'soonest', SESSIONS);
    expect(input.map((r) => r.id)).toEqual(before);
  });

  it('sorts newest first and oldest first by createdAt', () => {
    const input = [newPlain, oldPlain];
    expect(sortRequests(input, 'newest', SESSIONS).map((r) => r.id)).toEqual(['A', 'G']);
    expect(sortRequests(input, 'oldest', SESSIONS).map((r) => r.id)).toEqual(['G', 'A']);
  });

  it('groups by session name, keeping soonest order inside each group', () => {
    const names = new Map([
      ['s1', { name: 'Zeta', handle: null }],
      ['s2', { name: 'Alpha', handle: null }],
    ]);
    const b = req({ id: 'b', session: 's1', createdAt: iso(NOW - 9 * MIN) });
    const a = req({ id: 'a', session: 's2', createdAt: iso(NOW - 1 * MIN) });
    const c = req({ id: 'c', session: 's2', priority: 'urgent', createdAt: iso(NOW - 1 * MIN) });
    const ids = sortRequests([b, a, c], 'session', names).map((r) => r.id);
    expect(ids).toEqual(['c', 'a', 'b']);
  });
});

describe('applyFilters', () => {
  const sess1 = req({ id: 'x1', session: 's1', lead: 'lead1', space: 'sp1', machine: 'laptop' });
  const sess2 = req({ id: 'x2', session: 's2', lead: null, space: 'sp2', machine: 'desk' });
  const waitingOther = req({
    id: 'w',
    session: 's2',
    lead: null,
    space: 'sp2',
    machine: 'desk',
    waiting: true,
    waitingUntil: iso(NOW + MIN),
  });
  const all = [sess1, sess2, waitingOther];

  it('keeps everything with no filters', () => {
    expect(applyFilters(all, NO_FILTERS)).toEqual({ shown: all, hiddenCount: 0 });
  });

  it('always shows a waiting request, whatever the filters', () => {
    const { shown, hiddenCount } = applyFilters(all, { ...NO_FILTERS, sessions: ['s1'] });
    expect(shown.map((r) => r.id)).toEqual(['x1', 'w']);
    expect(hiddenCount).toBe(1);
  });

  it('filters by lead group', () => {
    const { shown } = applyFilters(all, { ...NO_FILTERS, leads: ['lead1'] });
    expect(shown.map((r) => r.id)).toEqual(['x1', 'w']);
  });

  it('filters by space', () => {
    const { shown } = applyFilters(all, { ...NO_FILTERS, spaces: ['sp1'] });
    expect(shown.map((r) => r.id)).toEqual(['x1', 'w']);
  });

  it('filters by type and by machine', () => {
    const review = req({ id: 'rv', kind: 'review', machine: 'desk' });
    const { shown: byType } = applyFilters([sess1, review], {
      ...NO_FILTERS,
      types: ['review'],
    });
    expect(byType.map((r) => r.id)).toEqual(['rv']);
    const { shown: byMachine } = applyFilters(all, { ...NO_FILTERS, machines: ['laptop'] });
    expect(byMachine.map((r) => r.id)).toEqual(['x1', 'w']);
  });
});

describe('cardsOf', () => {
  const ageOnly = req({ id: 'age', createdAt: iso(NOW - 5 * MIN) });

  it('uses waiting as the why-now when it has a deadline', () => {
    const r = req({ waiting: true, waitingUntil: iso(NOW + 10_000), priority: 'urgent' });
    expect(cardsOf([r], ctx)[0]?.whyNow).toEqual({ kind: 'waiting', secondsLeft: 10 });
  });

  it('falls to urgent before expiry', () => {
    const r = req({ priority: 'urgent', expiresAt: iso(NOW + MIN) });
    expect(cardsOf([r], ctx)[0]?.whyNow).toEqual({ kind: 'urgent' });
  });

  it('shows expiry before the open-as tab', () => {
    const r = req({ expiresAt: iso(NOW + MIN), body: 'x'.repeat(601) });
    expect(cardsOf([r], ctx)[0]?.whyNow).toEqual({ kind: 'expires', at: iso(NOW + MIN) });
  });

  it('shows a tab before the terminal and age', () => {
    const r = req({ body: 'x'.repeat(601) });
    expect(cardsOf([r], ctx)[0]?.whyNow).toEqual({ kind: 'tab', lines: 1 });
  });

  it('shows terminal for attend before age', () => {
    const r = req({ kind: 'attend', blocked: 'question' });
    expect(cardsOf([r], ctx)[0]?.whyNow).toEqual({ kind: 'terminal' });
  });

  it('falls back to age last', () => {
    expect(cardsOf([ageOnly], ctx)[0]?.whyNow).toEqual({ kind: 'age', label: '5m' });
  });

  it('counts down whole seconds, rounding up and clamping at zero', () => {
    const at = (until: number) =>
      cardsOf([req({ waiting: true, waitingUntil: iso(until) })], ctx)[0]?.whyNow;
    expect(at(NOW + 57_400)).toEqual({ kind: 'waiting', secondsLeft: 58 });
    expect(at(NOW + 58_000)).toEqual({ kind: 'waiting', secondsLeft: 58 });
    expect(at(NOW - 5_000)).toEqual({ kind: 'waiting', secondsLeft: 0 });
  });

  it('fills the session name and handle from the session map for conduit requests', () => {
    const r = req({ requester: 'conduit', source: 'observed', session: 's2' });
    const card = cardsOf([r], ctx)[0];
    expect(card?.sessionName).toBe('Docs');
    expect(card?.handle).toBe('claude-3');
    expect(card?.conduit).toBe(true);
  });

  it('uses the requester as the handle for an agent request', () => {
    const card = cardsOf([req({ requester: 'codex-4', session: 's1' })], ctx)[0];
    expect(card?.handle).toBe('codex-4');
    expect(card?.sessionName).toBe('Build');
  });

  it('fills details from the space map, age and machine', () => {
    const card = cardsOf([req({ space: 'sp1', machine: 'laptop' })], ctx)[0];
    expect(card?.details).toEqual({ space: 'Conduit', age: '5m', machine: 'laptop' });
    expect(cardsOf([req({ space: null })], ctx)[0]?.details.space).toBeNull();
  });

  it('builds the accessible name', () => {
    const r = req({ id: 'aria', kind: 'confirm', title: 'Run tests?', session: 's1' });
    const card = cardsOf([req({ ...r, waiting: true, waitingUntil: iso(NOW + 58_000) })], ctx)[0];
    expect(card?.ariaName).toBe('Approve, Build, codex-4: Run tests?, 0:58 waiting');
  });

  it('builds the accessible name for an expiry and a tab', () => {
    const exp = cardsOf(
      [
        req({
          kind: 'text',
          title: 'Name?',
          session: 's2',
          requester: 'claude-3',
          expiresAt: iso(NOW + 5 * MIN),
        }),
      ],
      ctx,
    )[0];
    expect(exp?.ariaName).toBe('Answer, Docs, claude-3: Name?, Expires in 5m');
    const tab = cardsOf([req({ kind: 'review', title: 'Edit', draft: 'a\nb' })], ctx)[0];
    expect(tab?.ariaName).toBe('Review, Build, codex-4: Edit, 2 lines');
  });
});

describe('shortestWaiting', () => {
  it('returns the waiting request with the smallest waitingUntil', () => {
    const late = req({ id: 'late', session: 's2', waiting: true, waitingUntil: iso(NOW + 40_000) });
    const soon = req({ id: 'soon', session: 's1', waiting: true, waitingUntil: iso(NOW + 9_000) });
    const idle = req({ id: 'idle', waitingUntil: iso(NOW + 1_000) });
    expect(shortestWaiting([late, soon, idle], NOW)).toEqual({
      requestId: 'soon',
      sessionId: 's1',
      secondsLeft: 9,
    });
  });
  it('returns null when nothing waits', () => {
    expect(shortestWaiting([req()], NOW)).toBeNull();
  });
});

describe('filterOptions', () => {
  it('lists distinct sessions, leads, spaces, types and machines, sorted by label', () => {
    const rs = [
      req({ id: 'a', session: 's2', lead: 'lead1', space: 'sp2', kind: 'review', machine: 'desk' }),
      req({
        id: 'b',
        session: 's1',
        lead: 'lead1',
        space: 'sp1',
        kind: 'confirm',
        machine: 'laptop',
      }),
      req({ id: 'c', session: 's1', lead: null, space: null, kind: 'confirm', machine: 'desk' }),
    ];
    const opts = filterOptions(rs, { sessions: SESSIONS, spaces: SPACES });
    expect(opts.sessions).toEqual([
      { id: 's1', label: 'Build' },
      { id: 's2', label: 'Docs' },
    ]);
    expect(opts.leads).toEqual([{ id: 'lead1', label: 'Lead A' }]);
    expect(opts.spaces).toEqual([
      { id: 'sp1', label: 'Conduit' },
      { id: 'sp2', label: 'Website' },
    ]);
    expect(opts.types).toEqual(['approve', 'review']);
    expect(opts.machines).toEqual(['desk', 'laptop']);
  });
});

describe('ageLabel', () => {
  it('buckets seconds, minutes, hours and days', () => {
    expect(ageLabel(iso(NOW - 30_000), NOW)).toBe('<1m');
    expect(ageLabel(iso(NOW - 5 * MIN), NOW)).toBe('5m');
    expect(ageLabel(iso(NOW - 59 * MIN), NOW)).toBe('59m');
    expect(ageLabel(iso(NOW - 2 * 60 * MIN), NOW)).toBe('2h');
    expect(ageLabel(iso(NOW - 3 * 24 * 60 * MIN), NOW)).toBe('3d');
  });
});
