import { describe, expect, it, vi } from 'vitest';
import type { PermissionAnswer } from '../../src/conduit-mcp/policy-types';
import { parseRequestsFile, serializeRequestsFile } from '../../src/conduit-mcp/request-file';
import {
  createRequestService,
  PERSIST_COALESCE_MS,
  type RemotePermissionFields,
  type RequestService,
} from '../../src/conduit-mcp/request-service';
import type {
  AnsweredBy,
  PermissionAnswerResult,
  RequestRecord,
} from '../../src/conduit-mcp/request-types';
import type { Caller } from '../../src/conduit-mcp/tools';
import type { CallKey } from '../../src/conduit-mcp/window-waits';
import { REQUEST_BODY_MAX_BYTES, REQUEST_MIRROR_MAX } from '../../src/contracts/link-protocol';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function clock() {
  let now = T0;
  const timers = new Map<object, { fn: () => void; at: number }>();
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number): unknown {
      const handle = {};
      timers.set(handle, { fn, at: now + ms });
      return handle;
    },
    clearTimer(t: unknown): void {
      if (typeof t === 'object' && t !== null) timers.delete(t);
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let next: [object, { fn: () => void; at: number }] | undefined;
        for (const e of timers) {
          if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) next = e;
        }
        if (next === undefined) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function memoryIo(initial: string | null) {
  let text = initial;
  return {
    io: {
      read: () => text,
      write: async (t: string) => {
        text = t;
      },
    },
    current: () => text,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const alice: Caller = { handle: 'alice', sessionId: 's-alice' };
const key = (n: number): CallKey => ({ connId: 1, requestId: n });
const bob = { handle: 'bob', machineId: 'm-2' };
const EXPIRY = iso(T0 + 60 * MIN);

interface Harness {
  c: ReturnType<typeof clock>;
  service: RequestService;
  store: ReturnType<typeof memoryIo>;
  onPermissionAnswer: ReturnType<
    typeof vi.fn<
      (r: RequestRecord, a: PermissionAnswer, by: AnsweredBy) => Promise<PermissionAnswerResult>
    >
  >;
}

function harness(initial: string | null = null): Harness {
  const c = clock();
  const store = memoryIo(initial);
  let seq = 0;
  const onPermissionAnswer = vi.fn(
    async (
      _r: RequestRecord,
      _a: PermissionAnswer,
      _by: AnsweredBy,
    ): Promise<PermissionAnswerResult> => ({ ok: true }),
  );
  const service = createRequestService({
    io: store.io,
    machineId: 'm-1',
    now: c.now,
    newId: () => `r-${++seq}`,
    setTimer: (fn, ms) => c.setTimer(fn, ms),
    clearTimer: (t) => c.clearTimer(t),
    warn: () => {},
    stampOf: (sessionId) => ({ session: sessionId, space: 'proj', lead: null }),
    budgetMs: () => 300_000,
    deliver: async () => true,
    onChanged: () => {},
    onNew: () => undefined,
    replyToQuestion: async () => true,
    scheduler: {
      resumeNow: async () => true,
      autoResumeOn: () => true,
      dismissIssue: () => undefined,
    },
    onPermissionAnswer,
  });
  service.start();
  return { c, service, store, onPermissionAnswer };
}

const permFields = (over: Partial<RemotePermissionFields> = {}): RemotePermissionFields => ({
  tool: 'open_session' as const,
  why: 'open a session on bob',
  targets: [{ sessionId: null, path: '/secret/path', folder: null, projectId: null }],
  grantable: true,
  ...over,
});

describe('mirrorOf', () => {
  it('maps open requests and permissions to the wire type without targets or args', () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields({ grantable: false }), EXPIRY);
    const mirror = h.service.mirrorOf();
    expect(mirror).toHaveLength(1);
    const m = mirror[0];
    expect(m).toMatchObject({
      id: perm.id,
      kind: 'permission',
      state: 'open',
      requester: 'bob@m-2',
      answer: null,
      permission: { tool: 'open_session', why: 'open a session on bob', grantable: false },
    });
    expect(Object.keys(m).sort()).toEqual(
      [
        'answer',
        'body',
        'createdAt',
        'draft',
        'expiresAt',
        'id',
        'kind',
        'multi',
        'options',
        'permission',
        'priority',
        'requester',
        'state',
        'title',
      ].sort(),
    );
    expect(JSON.stringify(mirror)).not.toContain('/secret/path');
  });

  it('keeps requests that ended in the last 10 minutes and drops older ones', () => {
    const h = harness();
    const old = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    const recent = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    void h.service.applyRemoteAnswer(old.id, { outcome: 'denied' }, 'a-old', 'm-2');
    h.c.advance(5 * MIN);
    void h.service.applyRemoteAnswer(recent.id, { outcome: 'denied' }, 'a-new', 'm-2');
    h.c.advance(6 * MIN); // old ended 11 min ago, recent 6 min ago
    const ids = h.service.mirrorOf().map((m) => m.id);
    expect(ids).toEqual([recent.id]);
    expect(h.service.hasEnded()).toBe(true);
    h.c.advance(5 * MIN); // recent now 11 min ago
    expect(h.service.hasEnded()).toBe(false);
  });

  it('truncates the body to the byte cap at a character boundary and keeps newlines', () => {
    const h = harness();
    h.service.createRemotePermission(bob, permFields({ why: '€'.repeat(400) }), EXPIRY);
    const [m] = h.service.mirrorOf();
    expect(new TextEncoder().encode(m.permission?.why ?? '').length).toBeLessThanOrEqual(1024);
    expect(m.permission?.why).toBe('€'.repeat(341));
    // The body cap is 16 KB, so the 400-character body is whole; only the 1 KB why is cut.
    expect(m.body).toBe('€'.repeat(400));
    expect(new TextEncoder().encode(m.body).length).toBeLessThanOrEqual(REQUEST_BODY_MAX_BYTES);
  });

  it('replaces control characters in single-line fields but keeps them in bodies', () => {
    const h = harness();
    h.service.createRemotePermission(bob, permFields({ why: 'line1\nline2' }), EXPIRY);
    const [m] = h.service.mirrorOf();
    expect(m.permission?.why).toBe('line1 line2');
    expect(m.body).toBe('line1\nline2');
  });

  it('never sends more than the mirror cap', () => {
    const h = harness();
    for (let i = 0; i < REQUEST_MIRROR_MAX + 5; i++) {
      h.service.createRemotePermission(bob, permFields(), EXPIRY);
    }
    expect(h.service.mirrorOf()).toHaveLength(REQUEST_MIRROR_MAX);
  });

  it('fires onMirrorChange on create and end, and stops after unsubscribe', () => {
    const h = harness();
    const listener = vi.fn();
    const off = h.service.onMirrorChange(listener);
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    void h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a1', 'm-2');
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    h.service.createRemotePermission(bob, permFields(), EXPIRY);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('applyRemoteAnswer', () => {
  it('answers an agent request and the waiting call gets the answer', async () => {
    const h = harness();
    const waiting = h.service.tools.requestInput(
      alice,
      { kind: 'confirm', title: 'Deploy?' },
      key(1),
    );
    await flush();
    const [req] = h.service.mirrorOf();
    const res = h.service.applyRemoteAnswer(req.id, { outcome: 'approved' }, 'a1', 'm-2');
    expect(res).toEqual({ ok: true });
    const out = await waiting;
    expect(out).toEqual({
      ok: true,
      value: {
        state: 'answered',
        request_id: req.id,
        answer: expect.objectContaining({ outcome: 'approved', answered_by: 'you' }),
      },
    });
    const rec = h.service.mirrorOf().find((m) => m.id === req.id);
    expect(rec?.state).toBe('answered');
  });

  it('records the remote answerer on the stored answer', () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    void h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a1', 'm-2');
    return perm.ended.then((rec) => {
      expect(rec.answer?.answeredBy).toEqual({ kind: 'remote', machineId: 'm-2' });
    });
  });

  it('allows a grant on a grantable permission and maps it to the remote Always choice', async () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    const res = h.service.applyRemoteAnswer(
      perm.id,
      { outcome: 'allowed', grant: true },
      'a1',
      'm-2',
    );
    expect(res).toEqual({ ok: true });
    const rec = await perm.ended;
    expect(rec.state).toBe('answered');
    expect(rec.answer?.grant).toEqual({ who: 'peer', on: 'target', for: 'until-revoked' });
  });

  it('rejects a grant on a non-grantable permission and leaves it open', () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields({ grantable: false }), EXPIRY);
    const res = h.service.applyRemoteAnswer(
      perm.id,
      { outcome: 'allowed', grant: true },
      'a1',
      'm-2',
    );
    expect(res).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(h.service.mirrorOf()[0].state).toBe('open');
  });

  it('refuses a repeated answerId with the same result and does not apply twice', () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    const first = h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'dup', 'm-2');
    const again = h.service.applyRemoteAnswer('r-unknown', { outcome: 'denied' }, 'dup', 'm-2');
    expect(first).toEqual({ ok: true });
    expect(again).toEqual(first);
  });

  it('evicts the oldest answerId after 256 distinct ones', () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    expect(h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a-0', 'm-2')).toEqual({
      ok: true,
    });
    for (let i = 1; i <= 256; i++) {
      h.service.applyRemoteAnswer('r-unknown', { outcome: 'denied' }, `a-${i}`, 'm-2');
    }
    // The cached result is gone, so the repeat is judged afresh against the ended request.
    expect(h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a-0', 'm-2')).toMatchObject(
      {
        ok: false,
        reason: 'already_ended',
      },
    );
  });

  it('refuses an ended request with already_ended and an unknown one with not_found', () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a1', 'm-2');
    expect(h.service.applyRemoteAnswer(perm.id, { outcome: 'allowed' }, 'a2', 'm-2')).toMatchObject(
      {
        ok: false,
        reason: 'already_ended',
      },
    );
    expect(h.service.applyRemoteAnswer('nope', { outcome: 'denied' }, 'a3', 'm-2')).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('validates the answer like the local path', () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    expect(
      h.service.applyRemoteAnswer(perm.id, { outcome: 'approved' }, 'a1', 'm-2'),
    ).toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(h.service.mirrorOf()[0].state).toBe('open');
  });

  it('refuses an answer from a different controller than the one whose call asked', () => {
    const h = harness();
    const asked = { handle: 'bob', machineId: 'm-x' };
    const perm = h.service.createRemotePermission(asked, permFields(), EXPIRY);
    const other = h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a-y', 'm-y');
    expect(other).toMatchObject({ ok: false, reason: 'invalid_args' });
    if (!other.ok) expect(other.message).toBe('answered on the machine that asked');
    expect(h.service.mirrorOf()[0].state).toBe('open');
    expect(h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a-x', 'm-x')).toEqual({
      ok: true,
    });
  });

  it('refuses a local policy permission, which is answered on this machine', () => {
    const h = harness();
    const perm = h.service.createPermission(
      's-alice',
      {
        requester: 'alice',
        title: 'open_session',
        body: 'why',
        permission: {
          tool: 'open_session',
          why: 'why',
          targets: [],
          lateGrant: null,
          grantable: true,
        },
      },
      EXPIRY,
    );
    const res = h.service.applyRemoteAnswer(perm.id, { outcome: 'denied' }, 'a1', 'm-2');
    expect(res).toMatchObject({ ok: false, reason: 'invalid_args' });
    if (!res.ok) expect(res.message).toContain('m-1');
  });

  it('refuses answers to message questions', async () => {
    const h = harness();
    h.service.onQuestions([
      {
        messageId: 'msg-1',
        threadId: 't',
        from: 'carol',
        fromSession: null,
        subject: 'Question',
        body: 'ok?',
        sentAt: iso(T0),
      },
    ]);
    await flush();
    const [q] = h.service.mirrorOf();
    expect(
      h.service.applyRemoteAnswer(q.id, { outcome: 'answered', text: 'yes' }, 'a1', 'm-2'),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_args',
    });
  });
});

describe('createRemotePermission', () => {
  it('resolves with the answer', async () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    const waited = perm.ended;
    h.service.applyRemoteAnswer(perm.id, { outcome: 'denied', reason: 'no' }, 'a1', 'm-2');
    const rec = await waited;
    expect(rec.state).toBe('answered');
    expect(rec.answer?.outcome).toBe('denied');
    expect(rec.session).toBeNull();
    expect(rec.requester).toBe('bob@m-2');
    expect(rec.remote).toEqual({ handle: 'bob', machineId: 'm-2' });
  });

  it('resolves on expiry', async () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), iso(T0 + MIN));
    const waited = perm.ended;
    h.c.advance(MIN);
    const rec = await waited;
    expect(rec.state).toBe('expired');
  });
});

describe('remote records across stop and restart', () => {
  it('stop withdraws pending remote permissions and settles their waits', async () => {
    const h = harness();
    const perm = h.service.createRemotePermission(bob, permFields(), EXPIRY);
    const waited = perm.ended;
    await h.service.stop();
    const rec = await waited;
    expect(rec.state).toBe('withdrawn');
    expect(rec.withdrawReason).toBe('Conduit stopped');
  });

  it('withdraws remote permissions on restart, as local policy ones are', async () => {
    const first = harness();
    first.service.createRemotePermission(bob, permFields(), EXPIRY);
    first.c.advance(PERSIST_COALESCE_MS);
    await flush();
    const saved = first.store.current();
    expect(saved).not.toBeNull();
    const second = harness(saved);
    const [rec] = parseRequestsFile(saved, T0).file.requests;
    expect(rec.remote).toEqual({ handle: 'bob', machineId: 'm-2' });
    // Withdrawn at restart, so it is still in the mirror's 10-minute window.
    expect(second.service.mirrorOf().map((m) => m.state)).toEqual(['withdrawn']);
    second.c.advance(PERSIST_COALESCE_MS);
    await flush();
    const after = parseRequestsFile(second.store.current(), T0).file.requests[0];
    expect(after.state).toBe('withdrawn');
    expect(after.withdrawReason).toBe('Conduit restarted');
  });
});

describe('remote persistence', () => {
  it('round-trips the remote requester and a remote answerer', () => {
    const rec: RequestRecord = {
      id: 'r-1',
      origin: 'm-1',
      source: 'policy',
      kind: 'permission',
      requester: 'bob@m-2',
      remote: { handle: 'bob', machineId: 'm-2' },
      session: null,
      space: null,
      lead: null,
      machine: 'm-1',
      title: 'open_session',
      body: 'why',
      options: [],
      multi: false,
      draft: null,
      thread: null,
      messageId: null,
      blocked: null,
      priority: 'normal',
      createdAt: iso(T0),
      expiresAt: EXPIRY,
      default: null,
      contentKey: '',
      state: 'answered',
      endedAt: iso(T0),
      answer: {
        outcome: 'denied',
        answeredBy: { kind: 'remote', machineId: 'm-2' },
        at: iso(T0),
      },
      withdrawnBy: null,
      withdrawReason: null,
      supersededBy: null,
      deliveredAt: null,
      permission: {
        tool: 'open_session',
        why: 'why',
        targets: [],
        lateGrant: null,
        grantable: false,
      },
    };
    const parsed = parseRequestsFile(
      serializeRequestsFile({
        version: 1,
        requests: [rec],
        presence: { state: 'here', since: iso(T0), until: null, lastAway: null },
      }),
      T0,
    );
    expect(parsed.dropped).toBe(0);
    expect(parsed.file.requests[0]).toEqual(rec);
  });

  it('reads an old record without remote as not remote', () => {
    const old = {
      id: 'r-1',
      origin: 'm-1',
      source: 'agent',
      kind: 'confirm',
      requester: 'alice',
      session: 's-alice',
      space: null,
      lead: null,
      machine: 'm-1',
      title: 't',
      body: '',
      options: [],
      multi: false,
      draft: null,
      thread: null,
      messageId: null,
      blocked: null,
      priority: 'normal',
      createdAt: iso(T0),
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
    };
    const parsed = parseRequestsFile(
      JSON.stringify({
        version: 1,
        requests: [old],
        presence: { state: 'here', since: iso(T0), until: null, lastAway: null },
      }),
      T0,
    );
    expect(parsed.file.requests[0].remote ?? null).toBeNull();
  });
});
