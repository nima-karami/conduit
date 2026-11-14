import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestService,
  PERSIST_COALESCE_MS,
  type RequestService,
} from '../../src/conduit-mcp/request-service';
import type { RequestRecord } from '../../src/conduit-mcp/request-types';
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
}

function harness(opts: { initial?: string | null; budgetMs?: number } = {}): Harness {
  const c = clock();
  const store = memoryIo(opts.initial ?? null);
  const warnings: string[] = [];
  let seq = 0;
  const deliver = vi.fn(async (_r: RequestRecord) => true);
  const service = createRequestService({
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
  });
  service.start();
  return { c, service, store, warnings, deliver };
}

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
