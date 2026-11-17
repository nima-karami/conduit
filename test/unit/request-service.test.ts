import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionAnswer } from '../../src/conduit-mcp/policy-types';
import {
  createRequestService,
  PERSIST_COALESCE_MS,
  type RequestService,
} from '../../src/conduit-mcp/request-service';
import type { QuestionMessage, SessionNeedsYou } from '../../src/conduit-mcp/request-sources';
import type {
  AnsweredBy,
  PermissionAnswerResult,
  RequestRecord,
} from '../../src/conduit-mcp/request-types';
import type { Caller } from '../../src/conduit-mcp/tools';
import type { CallKey } from '../../src/conduit-mcp/window-waits';

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const HOUR = 3_600_000;

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
  const writes: string[] = [];
  return {
    io: {
      read: () => text,
      write: async (t: string) => {
        writes.push(t);
        text = t;
      },
    },
    writes,
    current: () => text,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const alice: Caller = { handle: 'alice', sessionId: 's-alice' };
const bob: Caller = { handle: 'bob', sessionId: 's-bob' };
const key = (n: number): CallKey => ({ connId: 1, requestId: n });
const ask = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'confirm',
  title: 'Deploy?',
  ...extra,
});

interface Harness {
  c: ReturnType<typeof clock>;
  service: RequestService;
  store: ReturnType<typeof memoryIo>;
  warnings: string[];
  deliver: ReturnType<typeof vi.fn<(r: RequestRecord) => Promise<boolean>>>;
  reply: ReturnType<typeof vi.fn<(r: RequestRecord, text: string) => Promise<boolean>>>;
  onNew: ReturnType<typeof vi.fn<(r: RequestRecord) => void>>;
  onPermissionAnswer: ReturnType<
    typeof vi.fn<
      (r: RequestRecord, a: PermissionAnswer, by: AnsweredBy) => Promise<PermissionAnswerResult>
    >
  >;
  scheduler: {
    resumeNow: ReturnType<typeof vi.fn<(sessionId: string) => Promise<boolean>>>;
    autoResumeOn: ReturnType<typeof vi.fn<(sessionId: string) => boolean>>;
    dismissIssue: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  };
}

function harness(opts: { initial?: string | null; budgetMs?: number } = {}): Harness {
  const c = clock();
  const store = memoryIo(opts.initial ?? null);
  const warnings: string[] = [];
  let seq = 0;
  const deliver = vi.fn(async (_r: RequestRecord) => true);
  const reply = vi.fn(async (_r: RequestRecord, _text: string) => true);
  const onNew = vi.fn((_r: RequestRecord) => undefined);
  const onPermissionAnswer = vi.fn(
    async (
      _r: RequestRecord,
      _a: PermissionAnswer,
      _by: AnsweredBy,
    ): Promise<PermissionAnswerResult> => ({
      ok: true,
    }),
  );
  const scheduler = {
    resumeNow: vi.fn(async (_sessionId: string) => true),
    autoResumeOn: vi.fn((_sessionId: string) => true),
    dismissIssue: vi.fn((_sessionId: string) => undefined),
  };
  const service = createRequestService({
    onRemotePermissionAnswer: () => ({ ok: true, createdGrantIds: [] }),
    rollbackRemotePermissionGrants: () => ({ ok: true }),
    io: store.io,
    machineId: 'm-00000001',
    now: c.now,
    newId: () => `r-${++seq}`,
    setTimer: (fn, ms) => c.setTimer(fn, ms),
    clearTimer: (t) => c.clearTimer(t),
    warn: (message) => {
      warnings.push(message);
    },
    stampOf: (sessionId) => ({ session: sessionId, space: 'proj', lead: null }),
    budgetMs: () => opts.budgetMs ?? 300_000,
    deliver,
    onChanged: () => {},
    onNew,
    replyToQuestion: reply,
    scheduler,
    onPermissionAnswer,
  });
  service.start();
  return { c, service, store, warnings, deliver, reply, onNew, scheduler, onPermissionAnswer };
}

const aliceFact = (over: Partial<SessionNeedsYou> = {}): SessionNeedsYou => ({
  sessionId: 's-alice',
  blocked: false,
  visible: false,
  resumeIssue: null,
  handle: 'alice',
  ...over,
});

const aliceQuestion = (over: Partial<QuestionMessage> = {}): QuestionMessage => ({
  messageId: 'msg-1',
  threadId: 'th-1',
  from: 'alice',
  fromSession: 's-alice',
  subject: '',
  body: 'Which branch?',
  sentAt: '2026-11-14T09:59:00.000Z',
  ...over,
});

function onlyOpenId(service: RequestService): string {
  const [first] = service.ui().open;
  if (first === undefined) throw new Error('no open request');
  return first.id;
}

let tmp: string | null = null;
afterEach(async () => {
  if (tmp !== null) {
    const fs = await import('node:fs');
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe('request service: waits and answers', () => {
  it('answered within the wait returns answered and does not deliver', async () => {
    const h = harness();
    const p = h.service.tools.requestInput(alice, ask({ wait_s: 60 }), key(1));
    const id = onlyOpenId(h.service);
    await h.service.answerFromRenderer(id, { outcome: 'approved' }, 7);
    expect(await p).toEqual({
      ok: true,
      value: {
        state: 'answered',
        request_id: id,
        answer: { outcome: 'approved', answered_by: 'you', at: expect.any(String) },
      },
    });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('unanswered returns open and a later answer delivers once', async () => {
    const h = harness();
    const p = h.service.tools.requestInput(alice, ask(), key(1));
    const id = onlyOpenId(h.service);
    h.c.advance(290_000);
    expect(await p).toEqual({ ok: true, value: { state: 'open', request_id: id } });
    expect(h.service.ui().open[0]?.waiting).toBe(false);

    await h.service.answerFromRenderer(id, { outcome: 'declined', reason: 'later' }, null);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ id, state: 'answered' }));
    expect(h.service.ui().ended[0]?.deliveredAt).not.toBeNull();

    h.service.retryDeliveries();
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it('a failed delivery is retried by retryDeliveries', async () => {
    const h = harness();
    h.deliver.mockResolvedValueOnce(false);
    const p = h.service.tools.requestInput(alice, ask(), key(1));
    const id = onlyOpenId(h.service);
    h.c.advance(290_000);
    await p;
    await h.service.answerFromRenderer(id, { outcome: 'approved' }, null);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.service.ui().ended[0]?.deliveredAt).toBeNull();

    h.service.retryDeliveries();
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(2);
    expect(h.service.ui().ended[0]?.deliveredAt).not.toBeNull();
  });

  it('a cancelled call returns null and the request stays open, not waiting', async () => {
    const h = harness();
    const k = key(1);
    const p = h.service.tools.requestInput(alice, ask(), k);
    expect(h.service.ui().open[0]?.waiting).toBe(true);
    h.service.cancelCalls((w) => w.key.requestId === k.requestId);
    expect(await p).toBeNull();
    expect(h.service.ui().open).toHaveLength(1);
    expect(h.service.ui().open[0]?.state).toBe('open');
    expect(h.service.ui().open[0]?.waiting).toBe(false);
  });

  it('a waiting request carries waitingUntil, and loses it when the call ends', async () => {
    const h = harness({ budgetMs: 120_000 });
    const k = key(1);
    const p = h.service.tools.requestInput(alice, ask(), k);
    expect(h.service.ui().open[0]?.waitingUntil).toBe(new Date(h.c.now() + 110_000).toISOString());
    h.service.cancelCalls((w) => w.key.requestId === k.requestId);
    await p;
    expect(h.service.ui().open[0]?.waitingUntil).toBeNull();
  });

  it('a repeat identical call attaches to the same request and waits again', async () => {
    const h = harness();
    const first = h.service.tools.requestInput(alice, ask(), key(1));
    const id = onlyOpenId(h.service);
    h.service.cancelCalls(() => true);
    await first;

    const second = h.service.tools.requestInput(alice, ask(), key(2));
    expect(h.service.ui().open).toHaveLength(1);
    expect(h.service.ui().open[0]?.waiting).toBe(true);
    await h.service.answerFromRenderer(id, { outcome: 'approved' }, null);
    expect(await second).toEqual({
      ok: true,
      value: {
        state: 'answered',
        request_id: id,
        answer: { outcome: 'approved', answered_by: 'you', at: expect.any(String) },
      },
    });
  });

  it('clamped_to is reported when wait_s exceeds the budget', async () => {
    const h = harness({ budgetMs: 60_000 });
    const p = h.service.tools.requestInput(alice, ask({ wait_s: 300 }), key(1));
    const id = onlyOpenId(h.service);
    h.c.advance(55_000);
    expect(await p).toEqual({
      ok: true,
      value: { state: 'open', request_id: id, clamped_to: 55 },
    });
  });

  it('a fifth wait from one session is rate_limited', async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      h.service.tools.requestInput(alice, ask({ title: `Q${i}` }), key(i));
    }
    const fifth = await h.service.tools.requestInput(alice, ask({ title: 'Q4' }), key(9));
    expect(fifth).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('a call without a session is not_in_session', async () => {
    const h = harness();
    const none: Caller = { handle: 'alice', sessionId: null };
    expect(await h.service.tools.requestInput(none, ask(), key(1))).toMatchObject({
      ok: false,
      error: { code: 'not_in_session' },
    });
  });
});

describe('request service: onNew', () => {
  it('onNew fires for a new request and not for an attached repeat', () => {
    const h = harness();
    void h.service.tools.requestInput(alice, ask(), key(1));
    const id = onlyOpenId(h.service);
    h.service.cancelCalls(() => true);
    void h.service.tools.requestInput(alice, ask(), key(2));
    expect(h.service.ui().open[0]?.id).toBe(id);
    expect(h.onNew).toHaveBeenCalledTimes(1);
    expect(h.onNew).toHaveBeenCalledWith(expect.objectContaining({ id, session: 's-alice' }));
  });

  it('onNew fires for a system request', () => {
    const h = harness();
    h.service.onAttention([aliceFact({ blocked: 'permission' })]);
    expect(h.onNew).toHaveBeenCalledTimes(1);
    expect(h.onNew).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'attend', source: 'observed' }),
    );
  });
});

describe('request service: withdraw and list', () => {
  it("withdrawing another session's request is not_found", async () => {
    const h = harness();
    void h.service.tools.requestInput(alice, ask(), key(1));
    const id = onlyOpenId(h.service);
    expect(h.service.tools.withdrawRequest(bob, { request_id: id })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(h.service.ui().open).toHaveLength(1);
  });

  it('list_requests returns only the caller session requests', () => {
    const h = harness();
    void h.service.tools.requestInput(alice, ask({ title: 'Alice asks' }), key(1));
    const aliceId = onlyOpenId(h.service);
    void h.service.tools.requestInput(bob, ask({ title: 'Bob asks' }), key(2));

    expect(h.service.tools.listRequests(alice, {})).toMatchObject({
      ok: true,
      value: {
        requests: [{ request_id: aliceId, title: 'Alice asks', state: 'open', waiting: true }],
      },
    });
  });
});

describe('request service: presence', () => {
  it('away until a time ends at that time and records lastAway', () => {
    const h = harness();
    const until = new Date(T0 + HOUR).toISOString();
    h.service.setAway(true, until);
    expect(h.service.presence()).toMatchObject({ state: 'away', until });

    h.c.advance(HOUR - 1);
    expect(h.service.presence().state).toBe('away');

    h.c.advance(1);
    expect(h.service.presence()).toEqual({
      state: 'here',
      since: new Date(T0 + HOUR).toISOString(),
      until: null,
      lastAway: {
        from: new Date(T0).toISOString(),
        to: new Date(T0 + HOUR).toISOString(),
      },
    });
  });

  it('humanActive ends away', () => {
    const h = harness();
    h.service.setAway(true, null);
    h.service.humanActive();
    expect(h.service.presence()).toMatchObject({
      state: 'here',
      lastAway: { from: expect.any(String), to: expect.any(String) },
    });
  });

  it('an invalid until is warned about and ignored', () => {
    const h = harness();
    h.service.setAway(true, 'soon');
    expect(h.service.presence().state).toBe('here');
    expect(h.warnings).toHaveLength(1);
  });
});

describe('request service: expiry default', () => {
  it('a default at expiry with nobody waiting delivers answered_by default', async () => {
    const h = harness();
    const open = await h.service.tools.requestInput(
      alice,
      ask({ expires_in: '2h', default: { outcome: 'approved' }, wait_s: 0 }),
      key(1),
    );
    const id = onlyOpenId(h.service);
    expect(open).toEqual({ ok: true, value: { state: 'open', request_id: id } });

    h.c.advance(2 * HOUR);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        state: 'answered',
        answer: expect.objectContaining({ answeredBy: { kind: 'default' } }),
      }),
    );
  });
});

describe('request service: persistence', () => {
  it('persists coalesced to one write per tick', async () => {
    const h = harness();
    void h.service.tools.requestInput(alice, ask({ title: 'A', wait_s: 0 }), key(1));
    void h.service.tools.requestInput(alice, ask({ title: 'B', wait_s: 0 }), key(2));
    h.service.setAway(true, null);

    h.c.advance(PERSIST_COALESCE_MS - 1);
    expect(h.store.writes).toHaveLength(0);
    h.c.advance(1);
    expect(h.store.writes).toHaveLength(1);
    const saved = JSON.parse(h.store.writes[0] ?? '{}');
    expect(saved.requests).toHaveLength(2);
    expect(saved.presence.state).toBe('away');

    h.c.advance(10 * PERSIST_COALESCE_MS);
    expect(h.store.writes).toHaveLength(1);
  });

  it('a failed save is written again on stop', async () => {
    const h = harness();
    const ok = h.store.io.write;
    h.store.io.write = async () => {
      throw new Error('disk full');
    };
    h.service.setAway(true, null);
    h.c.advance(PERSIST_COALESCE_MS);
    await flush();
    expect(h.warnings).toContain('requests.json could not be saved');
    h.store.io.write = ok;
    await h.service.stop();
    expect(h.store.writes).toHaveLength(1);
    expect(JSON.parse(h.store.writes[0] ?? '{}').presence.state).toBe('away');
  });

  it('never writes after a newer file', async () => {
    const newer = JSON.stringify({ version: 2, requests: [] });
    const h = harness({ initial: newer });
    expect(h.warnings).toContain(
      'requests.json is from a newer version; requests will not be saved',
    );
    void h.service.tools.requestInput(alice, ask({ wait_s: 0 }), key(1));
    h.service.setAway(true, null);
    h.c.advance(10_000);
    await h.service.stop();
    expect(h.store.writes).toHaveLength(0);
    expect(h.store.current()).toBe(newer);
  });

  it('onSessionDeleted orphans the session requests', async () => {
    const h = harness();
    const p = h.service.tools.requestInput(alice, ask(), key(1));
    const id = onlyOpenId(h.service);
    h.service.onSessionDeleted('s-alice');
    expect(await p).toBeNull();
    expect(h.service.ui().open).toHaveLength(0);
    expect(h.service.ui().ended[0]).toMatchObject({ id, state: 'orphaned', waiting: false });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });
});

describe('request service: needs-you sources', () => {
  it('onAttention raises one attend request for a hidden blocked session and resolves it when the prompt clears', () => {
    const h = harness();
    const blocked = aliceFact({ blocked: 'permission' });
    h.service.onAttention([blocked]);
    h.service.onAttention([blocked]);
    expect(h.service.ui().open).toHaveLength(1);
    expect(h.service.ui().open[0]).toMatchObject({
      source: 'observed',
      kind: 'attend',
      session: 's-alice',
      requester: 'alice',
      blocked: 'permission',
      state: 'open',
    });
    h.service.onAttention([aliceFact({ blocked: false })]);
    expect(h.service.ui().open).toHaveLength(0);
    expect(h.service.ui().ended[0]).toMatchObject({ source: 'observed', state: 'resolved' });
  });

  it('a scheduler answer Resume now calls resumeNow and is not raised again while the issue persists', async () => {
    const h = harness();
    const limited = aliceFact({ resumeIssue: 'usage limit, no reset time' });
    h.service.onAttention([limited]);
    const [request] = h.service.ui().open;
    expect(request).toMatchObject({
      source: 'scheduler',
      kind: 'choose',
      session: 's-alice',
      body: 'usage limit, no reset time',
      options: [{ label: 'Resume now' }, { label: 'Turn auto-resume on' }],
    });
    if (request === undefined) throw new Error('no scheduler request');
    const result = await h.service.answerFromRenderer(
      request.id,
      { outcome: 'chosen', values: ['Resume now'] },
      1,
    );
    expect(result).toMatchObject({ ok: true, request: { state: 'answered' } });
    expect(h.scheduler.resumeNow).toHaveBeenCalledWith('s-alice');
    h.service.onAttention([limited]);
    expect(h.service.ui().open).toHaveLength(0);
  });

  it('the issue clearing lets a later issue raise again', async () => {
    const h = harness();
    h.service.onAttention([aliceFact({ resumeIssue: 'first limit' })]);
    const [first] = h.service.ui().open;
    if (first === undefined) throw new Error('no scheduler request');
    await h.service.answerFromRenderer(first.id, { outcome: 'chosen', values: ['Resume now'] }, 1);
    h.service.onAttention([aliceFact({ resumeIssue: null })]);
    h.service.onAttention([aliceFact({ resumeIssue: 'second limit' })]);
    expect(h.service.ui().open).toHaveLength(1);
    expect(h.service.ui().open[0]).toMatchObject({ source: 'scheduler', body: 'second limit' });
  });

  it('Turn auto-resume on calls autoResumeOn', async () => {
    const h = harness();
    const limited = aliceFact({ resumeIssue: 'usage limit' });
    h.service.onAttention([limited]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no scheduler request');
    await h.service.answerFromRenderer(
      request.id,
      { outcome: 'chosen', values: ['Turn auto-resume on'] },
      1,
    );
    expect(h.scheduler.autoResumeOn).toHaveBeenCalledWith('s-alice');
    expect(h.scheduler.resumeNow).not.toHaveBeenCalled();
    h.service.onAttention([limited]);
    expect(h.service.ui().open).toHaveLength(0);
  });

  it('an answer that re-raises the same issue synchronously does not ask again', async () => {
    const h = harness();
    const limited = aliceFact({ resumeIssue: 'usage limit' });
    h.service.onAttention([limited]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no scheduler request');
    h.scheduler.autoResumeOn.mockImplementationOnce(() => {
      h.service.onAttention([limited]);
      return true;
    });
    await h.service.answerFromRenderer(
      request.id,
      { outcome: 'chosen', values: ['Turn auto-resume on'] },
      1,
    );
    expect(h.service.ui().open).toHaveLength(0);
  });

  it('Skip on a scheduler request calls dismissIssue', async () => {
    const h = harness();
    h.service.onAttention([aliceFact({ resumeIssue: 'usage limit' })]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no scheduler request');
    await h.service.answerFromRenderer(request.id, { outcome: 'dismissed' }, 1);
    expect(h.scheduler.dismissIssue).toHaveBeenCalledWith('s-alice');
    expect(h.scheduler.resumeNow).not.toHaveBeenCalled();
  });

  it('answering a question replies in its thread then answers; a failed reply leaves it open', async () => {
    const h = harness();
    h.service.onQuestions([aliceQuestion()]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no message request');
    expect(request).toMatchObject({
      source: 'message',
      kind: 'text',
      thread: 'th-1',
      messageId: 'msg-1',
      title: 'alice asked you a question',
    });

    h.reply.mockResolvedValueOnce(false);
    const failed = await h.service.answerFromRenderer(
      request.id,
      { outcome: 'answered', text: 'main' },
      1,
    );
    expect(failed).toMatchObject({
      ok: false,
      reason: 'not_answerable',
      message: 'the reply could not be sent; try again',
      request: { id: request.id, state: 'open' },
    });
    expect(h.service.ui().open).toHaveLength(1);

    let openWhileReplying = 0;
    h.reply.mockImplementationOnce(async () => {
      openWhileReplying = h.service.ui().open.length;
      return true;
    });
    const sent = await h.service.answerFromRenderer(
      request.id,
      { outcome: 'answered', text: 'main' },
      1,
    );
    expect(openWhileReplying).toBe(1);
    expect(sent).toMatchObject({ ok: true, request: { state: 'answered' } });
    expect(h.reply).toHaveBeenCalledTimes(2);
    expect(h.reply).toHaveBeenLastCalledWith(expect.objectContaining({ id: request.id }), 'main');
    expect(h.service.ui().open).toHaveLength(0);
  });

  it('marking the question read during its reply does not resolve the request being answered', async () => {
    const h = harness();
    h.service.onQuestions([aliceQuestion()]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no message request');
    h.reply.mockImplementationOnce(async () => {
      h.service.onQuestions([]);
      return true;
    });
    const sent = await h.service.answerFromRenderer(
      request.id,
      { outcome: 'answered', text: 'main' },
      1,
    );
    expect(sent).toMatchObject({ ok: true, request: { state: 'answered' } });
    expect(h.service.ui().ended.find((r) => r.id === request.id)).toMatchObject({
      state: 'answered',
    });
  });

  it('a second answer while the first reply is in flight does not send a second reply', async () => {
    const h = harness();
    h.service.onQuestions([aliceQuestion()]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no message request');
    let release: (sent: boolean) => void = () => undefined;
    h.reply.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const first = h.service.answerFromRenderer(request.id, { outcome: 'answered', text: 'a' }, 1);
    const second = await h.service.answerFromRenderer(
      request.id,
      { outcome: 'answered', text: 'b' },
      2,
    );
    expect(second).toMatchObject({ ok: false, reason: 'not_answerable' });
    release(true);
    expect(await first).toMatchObject({ ok: true, request: { state: 'answered' } });
    expect(h.reply).toHaveBeenCalledTimes(1);
  });

  it('a dismissed question is not raised again', async () => {
    const h = harness();
    h.service.onQuestions([aliceQuestion()]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no message request');
    await h.service.answerFromRenderer(request.id, { outcome: 'dismissed' }, 1);
    expect(h.reply).not.toHaveBeenCalled();
    h.service.onQuestions([aliceQuestion()]);
    expect(h.service.ui().open).toHaveLength(0);
  });

  it('an answered question that is still unread is not raised again', async () => {
    const h = harness();
    h.service.onQuestions([aliceQuestion()]);
    const [request] = h.service.ui().open;
    if (request === undefined) throw new Error('no message request');
    await h.service.answerFromRenderer(request.id, { outcome: 'answered', text: 'yes' }, 1);
    h.service.onQuestions([aliceQuestion()]);
    expect(h.service.ui().open).toHaveLength(0);
  });
});

function seedRecord(over: Partial<RequestRecord>): RequestRecord {
  return {
    id: 'r-agent-1',
    origin: 'm-00000001',
    source: 'agent',
    kind: 'confirm',
    requester: 'alice',
    session: 's-alice',
    space: 'proj',
    lead: null,
    machine: 'm-00000001',
    title: 'Deploy?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: new Date(T0 - HOUR).toISOString(),
    expiresAt: null,
    default: null,
    contentKey: 'k',
    state: 'answered',
    endedAt: new Date(T0 - 60_000).toISOString(),
    answer: {
      outcome: 'approved',
      answeredBy: { kind: 'default' },
      at: new Date(T0 - 60_000).toISOString(),
    },
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    permission: null,
    ...over,
  };
}

const permissionRecord = (over: Partial<RequestRecord> = {}): RequestRecord =>
  seedRecord({
    id: 'r-perm-1',
    source: 'policy',
    kind: 'permission',
    state: 'expired',
    answer: null,
    permission: { tool: 'send_message', why: 'reach s2', targets: [], lateGrant: null },
    createdAt: new Date(T0 - 30 * 60_000).toISOString(),
    ...over,
  });

const fileOf = (requests: RequestRecord[]): string => JSON.stringify({ version: 1, requests });

describe('permission records stay out of the agent tools and the UI', () => {
  it('answerFromRenderer refuses a permission record with not_answerable', async () => {
    const h = harness({ initial: fileOf([permissionRecord()]) });
    const out = await h.service.answerFromRenderer('r-perm-1', { outcome: 'allowed' }, 1);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('not_answerable');
  });

  it('wait_request answers not_found for a permission record', async () => {
    const h = harness({ initial: fileOf([permissionRecord()]) });
    const out = await h.service.tools.waitRequest(alice, { request_id: 'r-perm-1' }, key(1));
    expect(out).not.toBeNull();
    if (out === null || out.ok) throw new Error('expected a refusal');
    expect(out.error.code).toBe('not_found');
  });

  it('withdraw_request on a live permission from its own session is not_found, and it stays open', async () => {
    const h = harness();
    const r = h.service.createPermission(
      's-alice',
      {
        requester: 'alice',
        title: 'close_session',
        body: 'Closes claude-4',
        permission: { tool: 'close_session', why: 'reach', targets: [], lateGrant: null },
      },
      new Date(T0 + HOUR).toISOString(),
    );
    const out = h.service.tools.withdrawRequest(alice, { request_id: r.id });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('not_found');
    const still = await h.service.answerPermission(
      r.id,
      { outcome: 'denied' },
      { kind: 'you', windowId: 1 },
    );
    expect(still).toEqual({ ok: true });
  });

  it('list_requests leaves permission records out, before its limit applies', () => {
    const h = harness({ initial: fileOf([seedRecord({}), permissionRecord()]) });
    const all = h.service.tools.listRequests(alice, { state: 'all' });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.requests.map((r) => r.request_id)).toEqual(['r-agent-1']);
    const one = h.service.tools.listRequests(alice, { state: 'all', limit: 1 });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.value.requests.map((r) => r.request_id)).toEqual(['r-agent-1']);
  });

  it('ui() keeps permission records out of open and ended', () => {
    const h = harness({
      initial: fileOf([
        seedRecord({}),
        permissionRecord(),
        permissionRecord({
          id: 'r-perm-open',
          state: 'open',
          endedAt: null,
          expiresAt: new Date(T0 + HOUR).toISOString(),
        }),
      ]),
    });
    const ui = h.service.ui();
    expect(ui.open.map((r) => r.id)).toEqual([]);
    expect(ui.ended.map((r) => r.id)).toEqual(['r-agent-1']);
  });
});

describe('permission requests in the service', () => {
  const EXPIRY = new Date(T0 + HOUR).toISOString();
  const you = { kind: 'you' as const, windowId: 1 };
  const fields = {
    requester: 'alice',
    title: 'close_session',
    body: 'Closes claude-4',
    permission: { tool: 'close_session' as const, why: 'reach', targets: [], lateGrant: null },
  };

  it('createPermission opens a permission record and answerPermission hands the answer to onPermissionAnswer', async () => {
    const h = harness();
    const r = h.service.createPermission('s-alice', fields, EXPIRY);
    expect(r).toMatchObject({
      kind: 'permission',
      source: 'policy',
      state: 'open',
      requester: 'alice',
    });
    const out = await h.service.answerPermission(r.id, { outcome: 'allowed' }, you);
    expect(out).toEqual({ ok: true });
    expect(h.onPermissionAnswer).toHaveBeenCalledTimes(1);
    expect(h.onPermissionAnswer.mock.calls[0]?.[1]).toEqual({ outcome: 'allowed' });
  });

  it('a live permission stays out of ui().open', () => {
    const h = harness();
    h.service.createPermission('s-alice', fields, EXPIRY);
    expect(h.service.ui().open).toEqual([]);
  });

  it('answerPermission refuses an agent request as not_answerable', async () => {
    const h = harness({
      initial: fileOf([
        seedRecord({
          id: 'r-agent-open',
          state: 'open',
          endedAt: null,
          answer: null,
          expiresAt: null,
          kind: 'confirm',
        }),
      ]),
    });
    const out = await h.service.answerPermission('r-agent-open', { outcome: 'allowed' }, you);
    expect(out).toMatchObject({ ok: false, reason: 'not_answerable' });
    expect(h.onPermissionAnswer).not.toHaveBeenCalled();
  });

  it('answerPermission refuses an unknown request as not_found', async () => {
    const h = harness();
    const out = await h.service.answerPermission('r-missing', { outcome: 'allowed' }, you);
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('answerPermission refuses an answer the permission does not take as invalid_answer', async () => {
    const h = harness();
    const r = h.service.createPermission('s-alice', fields, EXPIRY);
    const out = await h.service.answerPermission(r.id, { outcome: 'approved' }, you);
    expect(out).toMatchObject({ ok: false, reason: 'invalid_answer' });
    expect(h.onPermissionAnswer).not.toHaveBeenCalled();
  });

  it('answerPermission refuses an ended permission as already_ended', async () => {
    const h = harness();
    const r = h.service.createPermission('s-alice', fields, EXPIRY);
    h.service.endPermission(r.id, 'answered', { outcome: 'denied' }, null, you);
    const out = await h.service.answerPermission(r.id, { outcome: 'denied' }, you);
    expect(out).toMatchObject({ ok: false, reason: 'already_ended' });
    expect(h.onPermissionAnswer).not.toHaveBeenCalled();
  });

  it('endPermission answered records the answer; withdrawn records conduit and its reason', async () => {
    const h = harness();
    const a = h.service.createPermission('s-alice', fields, EXPIRY);
    const b = h.service.createPermission('s-alice', fields, EXPIRY);
    h.service.endPermission(a.id, 'answered', { outcome: 'allowed' }, null, {
      kind: 'you',
      windowId: 7,
    });
    h.service.endPermission(b.id, 'withdrawn', null, 'the policy now denies it', you);
    h.c.advance(PERSIST_COALESCE_MS);
    await flush();
    const saved = JSON.parse(h.store.current() ?? '{}') as { requests: RequestRecord[] };
    const byId = new Map(saved.requests.map((r) => [r.id, r]));
    expect(byId.get(a.id)).toMatchObject({
      state: 'answered',
      answer: { outcome: 'allowed', answeredBy: { kind: 'you', windowId: 7 } },
    });
    expect(byId.get(b.id)).toMatchObject({
      state: 'withdrawn',
      withdrawnBy: 'conduit',
      withdrawReason: 'the policy now denies it',
    });
  });

  it('a late grant on an expired permission is delegated, recorded once, and its notice delivered once', async () => {
    const h = harness({ initial: fileOf([permissionRecord()]) });
    const out = await h.service.answerPermission(
      'r-perm-1',
      { outcome: 'allowed', grant: { who: 'session', on: 'anywhere', for: 'session-end' } },
      you,
    );
    expect(out).toEqual({ ok: true });
    expect(h.onPermissionAnswer).toHaveBeenCalledTimes(1);
    expect(h.service.answerLate('r-perm-1', 'g-late')).toEqual({ ok: true });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]?.[0]).toMatchObject({
      id: 'r-perm-1',
      state: 'expired',
      permission: { lateGrant: 'g-late' },
    });
  });

  it('a late grant is refused for a forced ask, which is approve-once at most', async () => {
    const h = harness({
      initial: fileOf([
        permissionRecord({
          permission: {
            tool: 'send_message',
            why: 'connect a new machine',
            targets: [],
            lateGrant: null,
            grantable: false,
          },
        }),
      ]),
    });
    const out = await h.service.answerPermission(
      'r-perm-1',
      { outcome: 'allowed', grant: { who: 'session', on: 'anywhere', for: 'session-end' } },
      you,
    );
    expect(out).toMatchObject({ ok: false, reason: 'already_ended' });
    expect(h.onPermissionAnswer).not.toHaveBeenCalled();
  });

  it('a second late grant on the same permission is refused as not_answerable', () => {
    const h = harness({
      initial: fileOf([
        permissionRecord({
          permission: { tool: 'send_message', why: 'reach s2', targets: [], lateGrant: 'g-first' },
        }),
      ]),
    });
    expect(h.service.answerLate('r-perm-1', 'g-second')).toMatchObject({
      ok: false,
      reason: 'not_answerable',
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('an expired permission answered without a grant is already_ended', async () => {
    const h = harness({ initial: fileOf([permissionRecord()]) });
    const out = await h.service.answerPermission('r-perm-1', { outcome: 'allowed' }, you);
    expect(out).toMatchObject({ ok: false, reason: 'already_ended' });
    expect(h.onPermissionAnswer).not.toHaveBeenCalled();
  });
});
