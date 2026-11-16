import { describe, expect, it } from 'vitest';
import type { CreateInput } from '../../src/conduit-mcp/request-args';
import {
  CAP_CREATED_PER_HOUR,
  CAP_OPEN_PER_REQUESTER,
  CAP_OPEN_PER_SERVER,
  createRequestQueue,
  HISTORY_MS,
  type QueueDeps,
  type Stamp,
} from '../../src/conduit-mcp/request-queue';
import type { RequestRecord } from '../../src/conduit-mcp/request-types';

interface FakeTimer {
  at: number;
  fn: () => void;
  live: boolean;
}

function isFakeTimer(x: unknown): x is FakeTimer {
  return typeof x === 'object' && x !== null && 'live' in x && 'fn' in x;
}

const START = Date.UTC(2026, 10, 14);
const iso = (ms: number): string => new Date(ms).toISOString();

function harness() {
  let t = START;
  let seq = 0;
  const timers: FakeTimer[] = [];
  const ended: RequestRecord[] = [];
  let changed = 0;
  const deps: QueueDeps = {
    now: () => t,
    newId: () => `r_${String(++seq).padStart(12, '0')}`,
    machineId: 'm-test0001',
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (isFakeTimer(timer)) timer.live = false;
    },
    onEnded: (r) => {
      ended.push(r);
    },
    onChanged: () => {
      changed++;
    },
  };
  const queue = createRequestQueue(deps);
  const advance = (ms: number) => {
    const target = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.live && x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.live = false;
      due.fn();
    }
    t = target;
  };
  return {
    queue,
    ended,
    advance,
    liveTimers: () => timers.filter((x) => x.live).length,
    changes: () => changed,
    now: () => t,
  };
}

const stamp = (over: Partial<Stamp> = {}): Stamp => ({
  requester: 'alpha',
  session: 's1',
  space: 'proj',
  lead: 's1',
  ...over,
});

const input = (over: Partial<CreateInput> = {}): CreateInput => ({
  kind: 'confirm',
  title: 'Deploy?',
  body: 'ok to deploy',
  options: [],
  multi: false,
  draft: null,
  thread: null,
  priority: 'normal',
  expiresInMs: null,
  default: null,
  replaces: null,
  waitS: null,
  ...over,
});

function rec(over: Partial<RequestRecord>): RequestRecord {
  return {
    id: 'r_fixture',
    origin: 'm-test0001',
    source: 'agent',
    kind: 'confirm',
    requester: 'alpha',
    session: 's1',
    space: 'proj',
    lead: 's1',
    machine: 'm-test0001',
    title: 'T',
    body: 'B',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: iso(START),
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
    ...over,
  };
}

const YOU = { kind: 'you' as const, windowId: 1 };

const PERMISSION_FIELDS = {
  title: 'Allow send_message?',
  body: 'to reach another session',
  permission: { tool: 'send_message' as const, why: 'reach s2', targets: [], lateGrant: null },
};

describe('request queue', () => {
  it('first answer wins; second gets already_ended', () => {
    const h = harness();
    const out = h.queue.createAgent(stamp(), input());
    if (out.kind !== 'created') throw new Error('expected created');
    const first = h.queue.answer(out.request.id, { outcome: 'approved' }, YOU);
    expect(first.ok).toBe(true);
    const second = h.queue.answer(out.request.id, { outcome: 'declined' }, YOU);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_ended');
    expect(h.queue.get(out.request.id)?.state).toBe('answered');
    expect(h.queue.get(out.request.id)?.answer?.outcome).toBe('approved');
  });

  it('expiry with a default answers with answeredBy default', () => {
    const h = harness();
    const out = h.queue.createAgent(
      stamp(),
      input({ expiresInMs: 60_000, default: { outcome: 'approved' } }),
    );
    if (out.kind !== 'created') throw new Error('expected created');
    h.advance(59_999);
    expect(h.queue.get(out.request.id)?.state).toBe('open');
    h.advance(1);
    const r = h.queue.get(out.request.id);
    expect(r?.state).toBe('answered');
    expect(r?.answer?.answeredBy).toEqual({ kind: 'default' });
    expect(r?.answer?.outcome).toBe('approved');
    expect(r?.answer?.at).toBe(iso(START + 60_000));
    expect(r?.endedAt).toBe(iso(START + 60_000));
  });

  it('expiry without a default expires', () => {
    const h = harness();
    const out = h.queue.createAgent(stamp(), input({ expiresInMs: 5_000 }));
    if (out.kind !== 'created') throw new Error('expected created');
    h.advance(5_000);
    const r = h.queue.get(out.request.id);
    expect(r?.state).toBe('expired');
    expect(r?.answer).toBeNull();
    expect(h.ended.map((x) => x.id)).toEqual([out.request.id]);
  });

  it('replaces supersedes the old one and links supersededBy', () => {
    const h = harness();
    const a = h.queue.createAgent(stamp(), input({ title: 'first' }));
    if (a.kind !== 'created') throw new Error('expected created');
    const b = h.queue.createAgent(stamp(), input({ title: 'second', replaces: a.request.id }));
    if (b.kind !== 'created') throw new Error('expected created');
    const old = h.queue.get(a.request.id);
    expect(old?.state).toBe('superseded');
    expect(old?.supersededBy).toBe(b.request.id);
    expect(old?.endedAt).not.toBeNull();
    expect(h.ended.map((x) => x.id)).toEqual([a.request.id]);
    expect(h.queue.get(b.request.id)?.state).toBe('open');
  });

  it("replaces of another session's request is not_found", () => {
    const h = harness();
    const a = h.queue.createAgent(stamp({ session: 's1' }), input());
    if (a.kind !== 'created') throw new Error('expected created');
    const b = h.queue.createAgent(
      stamp({ session: 's2' }),
      input({ title: 'other', replaces: a.request.id }),
    );
    expect(b.kind).toBe('refused');
    if (b.kind !== 'refused') return;
    expect(b.error.code).toBe('not_found');
    expect(h.queue.get(a.request.id)?.state).toBe('open');
  });

  it('dedupe attaches without spending a cap', () => {
    const h = harness();
    const a = h.queue.createAgent(stamp(), input({ title: 'A' }));
    if (a.kind !== 'created') throw new Error('expected created');
    const again = h.queue.createAgent(stamp(), input({ title: 'A' }));
    expect(again.kind).toBe('attached');
    if (again.kind !== 'attached') return;
    expect(again.request.id).toBe(a.request.id);
    for (const title of ['B', 'C', 'D', 'E']) {
      expect(h.queue.createAgent(stamp(), input({ title })).kind).toBe('created');
    }
    expect(h.queue.open()).toHaveLength(CAP_OPEN_PER_REQUESTER);
    const sixth = h.queue.createAgent(stamp(), input({ title: 'F' }));
    expect(sixth.kind).toBe('refused');
  });

  it('dedupe of an urgent request attaches instead of hitting the urgent cap', () => {
    const h = harness();
    const u = h.queue.createAgent(stamp(), input({ title: 'U', priority: 'urgent' }));
    expect(u.kind).toBe('created');
    const again = h.queue.createAgent(stamp(), input({ title: 'U', priority: 'urgent' }));
    expect(again.kind).toBe('attached');
  });

  it('6th open from one requester is rate_limited', () => {
    const h = harness();
    for (let i = 0; i < CAP_OPEN_PER_REQUESTER; i++) {
      expect(h.queue.createAgent(stamp(), input({ title: `t${i}` })).kind).toBe('created');
    }
    const sixth = h.queue.createAgent(stamp(), input({ title: 't5' }));
    expect(sixth.kind).toBe('refused');
    if (sixth.kind !== 'refused') return;
    expect(sixth.error.code).toBe('rate_limited');
    expect(sixth.error.hint).toBe('you have 5 open requests; withdraw one or wait');
  });

  it('2nd urgent within 10 min is rate_limited', () => {
    const h = harness();
    expect(h.queue.createAgent(stamp(), input({ title: 'u1', priority: 'urgent' })).kind).toBe(
      'created',
    );
    h.advance(9 * 60_000);
    const second = h.queue.createAgent(stamp(), input({ title: 'u2', priority: 'urgent' }));
    expect(second.kind).toBe('refused');
    if (second.kind !== 'refused') return;
    expect(second.error.code).toBe('rate_limited');
    h.advance(60_000);
    expect(h.queue.createAgent(stamp(), input({ title: 'u3', priority: 'urgent' })).kind).toBe(
      'created',
    );
  });

  it('21st created in an hour is rate_limited', () => {
    const h = harness();
    for (let i = 0; i < CAP_CREATED_PER_HOUR; i++) {
      const out = h.queue.createAgent(stamp(), input({ title: `w${i}` }));
      if (out.kind !== 'created') throw new Error('expected created');
      h.queue.withdraw(out.request.id, 'requester', null);
    }
    const next = h.queue.createAgent(stamp(), input({ title: 'late' }));
    expect(next.kind).toBe('refused');
    if (next.kind !== 'refused') return;
    expect(next.error.code).toBe('rate_limited');
    h.advance(3_600_000);
    expect(h.queue.createAgent(stamp(), input({ title: 'late' })).kind).toBe('created');
  });

  it('51st open on the server is rate_limited', () => {
    const h = harness();
    const perRequester = CAP_OPEN_PER_REQUESTER;
    const requesters = CAP_OPEN_PER_SERVER / perRequester;
    for (let r = 0; r < requesters; r++) {
      for (let i = 0; i < perRequester; i++) {
        const out = h.queue.createAgent(
          stamp({ requester: `r${r}`, session: `s${r}` }),
          input({ title: `t${i}` }),
        );
        expect(out.kind).toBe('created');
      }
    }
    expect(h.queue.open()).toHaveLength(CAP_OPEN_PER_SERVER);
    const extra = h.queue.createAgent(stamp({ requester: 'late', session: 'sl' }), input());
    expect(extra.kind).toBe('refused');
    if (extra.kind !== 'refused') return;
    expect(extra.error.code).toBe('rate_limited');
  });

  it('a replace at the server cap is allowed because it adds no open request', () => {
    const h = harness();
    for (let r = 0; r < CAP_OPEN_PER_SERVER / CAP_OPEN_PER_REQUESTER; r++) {
      for (let i = 0; i < CAP_OPEN_PER_REQUESTER; i++) {
        h.queue.createAgent(
          stamp({ requester: `r${r}`, session: `s${r}` }),
          input({ title: `t${i}` }),
        );
      }
    }
    const old = h.queue.open().find((x) => x.session === 's0');
    if (old === undefined) throw new Error('no request of s0');
    const out = h.queue.createAgent(
      stamp({ requester: 'r0', session: 's0' }),
      input({ title: 'replacement', replaces: old.id }),
    );
    expect(out.kind).toBe('created');
    expect(h.queue.open()).toHaveLength(CAP_OPEN_PER_SERVER);
  });

  it('load resolves open observed and scheduler requests and keeps agent ones open', () => {
    const h = harness();
    h.queue.load([
      rec({ id: 'r_obs', source: 'observed', kind: 'attend', blocked: 'question' }),
      rec({
        id: 'r_sched',
        source: 'scheduler',
        kind: 'choose',
        options: [{ label: 'a' }, { label: 'b' }],
      }),
      rec({ id: 'r_agent', source: 'agent' }),
    ]);
    expect(h.queue.get('r_obs')?.state).toBe('resolved');
    expect(h.queue.get('r_sched')?.state).toBe('resolved');
    expect(h.queue.get('r_agent')?.state).toBe('open');
    expect(h.ended.map((x) => x.id).sort()).toEqual(['r_obs', 'r_sched']);
    expect(h.queue.open().map((x) => x.id)).toEqual(['r_agent']);
  });

  it('a load with nothing to end reports no change', () => {
    const h = harness();
    h.queue.load([rec({ id: 'r_agent', source: 'agent' })]);
    expect(h.changes()).toBe(0);
  });

  it('load withdraws an open permission, since its blocked call is gone', () => {
    const h = harness();
    const now = h.now();
    h.queue.load([
      rec({
        id: 'r_perm',
        source: 'policy',
        kind: 'permission',
        expiresAt: iso(now + 60_000),
        permission: { tool: 'send_message', why: 'reach s2', targets: [], lateGrant: null },
      }),
    ]);
    const r = h.queue.get('r_perm');
    expect(r?.state).toBe('withdrawn');
    expect(r?.withdrawnBy).toBe('conduit');
    expect(r?.withdrawReason).toBe('Conduit restarted');
    expect(h.ended.map((x) => x.id)).toEqual(['r_perm']);
    expect(h.liveTimers()).toBe(0);
  });

  it('load expires an overdue permission so a late answer still works, and withdraws the rest', () => {
    const h = harness();
    const now = h.now();
    const permission = {
      tool: 'send_message' as const,
      why: 'reach s2',
      targets: [],
      lateGrant: null,
    };
    h.queue.load([
      rec({
        id: 'r_overdue_perm',
        source: 'policy',
        kind: 'permission',
        expiresAt: iso(now - 1),
        permission,
      }),
      rec({
        id: 'r_perm',
        source: 'policy',
        kind: 'permission',
        expiresAt: iso(now + 60_000),
        permission,
      }),
    ]);
    const overdue = h.queue.get('r_overdue_perm');
    expect(overdue?.state).toBe('expired');
    expect(overdue?.withdrawnBy).toBeNull();
    expect(h.queue.answerLate('r_overdue_perm', 'g_late').ok).toBe(true);
    const rest = h.queue.get('r_perm');
    expect(rest?.state).toBe('withdrawn');
    expect(rest?.withdrawReason).toBe('Conduit restarted');
  });

  it('load ends overdue requests', () => {
    const h = harness();
    const now = h.now();
    h.queue.load([
      rec({ id: 'r_overdue', expiresAt: iso(now - 1) }),
      rec({ id: 'r_overdue_default', expiresAt: iso(now - 1), default: { outcome: 'approved' } }),
      rec({ id: 'r_future', expiresAt: iso(now + 1_000) }),
    ]);
    expect(h.queue.get('r_overdue')?.state).toBe('expired');
    const withDefault = h.queue.get('r_overdue_default');
    expect(withDefault?.state).toBe('answered');
    expect(withDefault?.answer?.answeredBy).toEqual({ kind: 'default' });
    expect(h.queue.get('r_future')?.state).toBe('open');
    expect(h.liveTimers()).toBe(1);
    h.advance(1_000);
    expect(h.queue.get('r_future')?.state).toBe('expired');
  });

  it('load purges ended requests older than 30 days', () => {
    const h = harness();
    const now = h.now();
    h.queue.load([
      rec({ id: 'r_old', state: 'withdrawn', endedAt: iso(now - HISTORY_MS - 1) }),
      rec({ id: 'r_recent', state: 'withdrawn', endedAt: iso(now - HISTORY_MS + 1_000) }),
    ]);
    expect(h.queue.get('r_old')).toBeUndefined();
    expect(h.queue.get('r_recent')?.state).toBe('withdrawn');
    expect(h.ended).toHaveLength(0);
  });

  it('orphanSession only touches open requests of that session', () => {
    const h = harness();
    const inS1 = h.queue.createAgent(stamp({ session: 's1' }), input({ title: 'in-s1' }));
    const answered = h.queue.createAgent(stamp({ session: 's1' }), input({ title: 'answered' }));
    const inS2 = h.queue.createAgent(stamp({ session: 's2' }), input({ title: 'in-s2' }));
    if (inS1.kind !== 'created' || answered.kind !== 'created' || inS2.kind !== 'created') {
      throw new Error('expected created');
    }
    h.queue.answer(answered.request.id, { outcome: 'approved' }, YOU);
    const orphaned = h.queue.orphanSession('s1');
    expect(orphaned.map((r) => r.id)).toEqual([inS1.request.id]);
    expect(h.queue.get(inS1.request.id)?.state).toBe('orphaned');
    expect(h.queue.get(answered.request.id)?.state).toBe('answered');
    expect(h.queue.get(inS2.request.id)?.state).toBe('open');
  });

  it('attend answer is not_answerable', () => {
    const h = harness();
    const attend = h.queue.createSystem(stamp({ requester: 'conduit', session: 's1' }), {
      source: 'observed',
      kind: 'attend',
      title: 'Needs you',
      body: '',
      options: [],
      thread: null,
      messageId: null,
      blocked: 'question',
      priority: 'normal',
    });
    const out = h.queue.answer(attend.id, { outcome: 'dismissed' }, YOU);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('not_answerable');
    expect(h.queue.get(attend.id)?.state).toBe('open');
  });

  it('onEnded fires once per end', () => {
    const h = harness();
    const out = h.queue.createAgent(stamp(), input({ title: 'x' }));
    if (out.kind !== 'created') throw new Error('expected created');
    h.queue.answer(out.request.id, { outcome: 'approved' }, YOU);
    h.queue.answer(out.request.id, { outcome: 'approved' }, YOU);
    h.queue.withdraw(out.request.id, 'requester', null);
    h.queue.resolve(out.request.id);
    expect(h.ended.map((r) => r.id)).toEqual([out.request.id]);
    expect(h.queue.ended(10, () => true).map((r) => r.id)).toEqual([out.request.id]);
  });

  it('an answer clears the expiry timer', () => {
    const h = harness();
    const out = h.queue.createAgent(stamp(), input({ expiresInMs: 60_000 }));
    if (out.kind !== 'created') throw new Error('expected created');
    expect(h.liveTimers()).toBe(1);
    h.queue.answer(out.request.id, { outcome: 'approved' }, YOU);
    expect(h.liveTimers()).toBe(0);
    h.advance(60_000);
    expect(h.queue.get(out.request.id)?.state).toBe('answered');
    expect(h.ended).toHaveLength(1);
  });
});

describe('permission requests', () => {
  it('createBound expires at its time to expired, never a default', () => {
    const h = harness();
    const expiresAt = iso(START + 60_000);
    const created = h.queue.createBound(stamp(), PERMISSION_FIELDS, expiresAt);
    expect(created.kind).toBe('permission');
    expect(created.source).toBe('policy');
    expect(created.expiresAt).toBe(expiresAt);
    expect(created.default).toBeNull();
    h.advance(59_999);
    expect(h.queue.get(created.id)?.state).toBe('open');
    h.advance(1);
    const r = h.queue.get(created.id);
    expect(r?.state).toBe('expired');
    expect(r?.answer).toBeNull();
    expect(r?.endedAt).toBe(expiresAt);
    expect(h.ended.map((x) => x.id)).toEqual([created.id]);
  });

  it('answerLate refuses when a late grant is already recorded', () => {
    const h = harness();
    const perm = h.queue.createBound(stamp(), PERMISSION_FIELDS, iso(START + 1_000));
    h.advance(1_000);
    expect(h.queue.answerLate(perm.id, 'g_first').ok).toBe(true);
    const second = h.queue.answerLate(perm.id, 'g_second');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('not_answerable');
    expect(h.queue.get(perm.id)?.permission?.lateGrant).toBe('g_first');
  });

  it('replaces refuses a permission record', () => {
    const h = harness();
    const perm = h.queue.createBound(stamp(), PERMISSION_FIELDS, iso(START + 60_000));
    const out = h.queue.createAgent(stamp(), input({ title: 'x', replaces: perm.id }));
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.error.code).toBe('not_found');
    expect(h.queue.get(perm.id)?.state).toBe('open');
  });

  it('ended applies its keep filter before the limit', () => {
    const h = harness();
    const a1 = h.queue.createAgent(stamp(), input({ title: 'a1' }));
    const a2 = h.queue.createAgent(stamp(), input({ title: 'a2' }));
    if (a1.kind !== 'created' || a2.kind !== 'created') throw new Error('expected created');
    h.queue.answer(a1.request.id, { outcome: 'approved' }, YOU);
    h.advance(1_000);
    h.queue.answer(a2.request.id, { outcome: 'approved' }, YOU);
    for (let i = 0; i < 3; i++) {
      h.advance(1_000);
      const p = h.queue.createBound(stamp(), PERMISSION_FIELDS, iso(h.now() + 60_000));
      h.queue.withdraw(p.id, 'requester', null);
    }
    const kept = h.queue.ended(2, (r) => r.kind !== 'permission');
    expect(kept.map((r) => r.id)).toEqual([a2.request.id, a1.request.id]);
  });

  it('the server cap ignores permission records', () => {
    const h = harness();
    for (let i = 0; i < CAP_OPEN_PER_SERVER; i++) {
      h.queue.createBound(stamp({ requester: `p${i}` }), PERMISSION_FIELDS, iso(h.now() + 60_000));
    }
    const out = h.queue.createAgent(stamp({ requester: 'late', session: 'sl' }), input());
    expect(out.kind).toBe('created');
  });

  it('createBound is uncapped for one requester', () => {
    const h = harness();
    const count = CAP_OPEN_PER_SERVER + 1;
    for (let i = 0; i < count; i++) {
      const r = h.queue.createBound(stamp(), PERMISSION_FIELDS, iso(h.now() + 60_000));
      expect(r.state).toBe('open');
    }
    expect(h.queue.open()).toHaveLength(count);
  });

  it('answerLate only on an expired permission', () => {
    const h = harness();
    const perm = h.queue.createBound(stamp(), PERMISSION_FIELDS, iso(START + 60_000));

    const early = h.queue.answerLate(perm.id, 'g_early');
    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.reason).toBe('not_answerable');
    expect(h.queue.get(perm.id)?.permission?.lateGrant).toBeNull();

    h.advance(60_000);
    const late = h.queue.answerLate(perm.id, 'g_late');
    expect(late.ok).toBe(true);
    const r = h.queue.get(perm.id);
    expect(r?.permission?.lateGrant).toBe('g_late');
    expect(r?.state).toBe('expired');
    expect(r?.answer).toBeNull();

    const agent = h.queue.createAgent(stamp(), input({ expiresInMs: 1_000 }));
    if (agent.kind !== 'created') throw new Error('expected created');
    h.advance(1_000);
    const notPermission = h.queue.answerLate(agent.request.id, 'g_agent');
    expect(notPermission.ok).toBe(false);
    if (notPermission.ok) return;
    expect(notPermission.reason).toBe('not_answerable');

    const answered = h.queue.createBound(stamp(), PERMISSION_FIELDS, iso(h.now() + 60_000));
    const answeredResult = h.queue.answer(answered.id, { outcome: 'allowed' }, YOU);
    expect(answeredResult.ok).toBe(true);
    expect(h.queue.get(answered.id)?.state).toBe('answered');
    const afterAnswer = h.queue.answerLate(answered.id, 'g_answered');
    expect(afterAnswer.ok).toBe(false);
    expect(h.queue.get(answered.id)?.permission?.lateGrant).toBeNull();

    const missing = h.queue.answerLate('r_missing', 'g_missing');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe('not_found');
  });
});
