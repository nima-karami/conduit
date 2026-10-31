import { describe, expect, it } from 'vitest';
import {
  ASK_TIMEOUT_MS,
  type CallFlow,
  type ControlCall,
  createCallFlow,
  MAX_ASKS_PER_CALLER,
} from '../../src/conduit-mcp/call-flow';
import type { PreparedCall } from '../../src/conduit-mcp/control-tools';
import type { JsonRpcId } from '../../src/conduit-mcp/json-rpc';
import type { ToolName, ToolPolicy, ToolPolicyPatch } from '../../src/conduit-mcp/tool-policy';
import type { Result } from '../../src/conduit-mcp/types';
import type { HostToWebview } from '../../src/protocol';

const CALLER = 'caller-1';
const ASK: ToolPolicy = { access: 'ask', when: 'viewing', move: 'yes' };
const ON: ToolPolicy = { access: 'on', when: 'viewing', move: 'yes' };

/** A deferred: `hold()` returns a promise the test releases with `go()`. */
function gate() {
  let open: () => void = () => {};
  let held = false;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return {
    hold: () => {
      held = true;
      return p;
    },
    go: () => open(),
    get held() {
      return held;
    },
  };
}

function setup() {
  const clock = { t: 1000 };
  const timers = new Map<number, { fn: () => void; at: number }>();
  let n = 0;
  let ask = 0;
  const sent: Array<{ to: string; msg: HostToWebview }> = [];
  const flashed: string[] = [];
  const writes: Array<{ id: string; tool: ToolName; patch: ToolPolicyPatch }> = [];
  const owners = new Map<string, number | null>([
    [CALLER, 1],
    ['caller-2', 2],
  ]);
  const policies = new Map<string, ToolPolicy>([
    [CALLER, ASK],
    ['caller-2', ASK],
  ]);
  const state = { messagingOn: true, policyWritten: 0, awaitingChanged: 0 };
  const flow = createCallFlow({
    now: () => clock.t,
    setTimer: (fn, ms) => {
      timers.set(++n, { fn, at: clock.t + ms });
      return n;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    newAskId: () => `ask-${++ask}`,
    ownerWindowOf: (id) => owners.get(id) ?? null,
    sendToOwner: (to, msg) => sent.push({ to, msg }),
    flashOwner: (id) => flashed.push(id),
    resolve: (id) => policies.get(id) ?? null,
    messagingOn: () => state.messagingOn,
    setSessionPolicy: (id, tool, patch) => {
      if (!policies.has(id)) return false;
      writes.push({ id, tool, patch });
      return true;
    },
    onPolicyWritten: () => state.policyWritten++,
    onAwaitingChanged: () => state.awaitingChanged++,
  });
  const advance = (ms: number) => {
    clock.t += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock.t) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  let req = 0;
  /** Starts a control call; `prepareGate`/`runGate` hold those steps until released. */
  const call = (
    o: {
      caller?: string;
      policy?: ToolPolicy;
      requestId?: JsonRpcId | null;
      connId?: number;
      prepareGate?: ReturnType<typeof gate>;
      runGate?: ReturnType<typeof gate>;
      prepareResult?: Result<PreparedCall<string>>;
    } = {},
  ) => {
    const spies = { run: 0, release: 0 };
    const prepared: PreparedCall<string> = {
      summary: { tool: 'open_session', path: '/repo', agent: 'claude', focus: true },
      run: async () => {
        spies.run++;
        if (o.runGate) await o.runGate.hold();
        return { ok: true, value: 'opened' };
      },
      release: () => {
        spies.release++;
      },
    };
    const caller = o.caller ?? CALLER;
    const inflight = flow.begin({
      connId: o.connId ?? 1,
      requestId: o.requestId === undefined ? ++req : o.requestId,
    });
    const c: ControlCall<string> = {
      inflight,
      caller: { sessionId: caller, handle: `claude-${caller}` },
      kind: 'claude',
      tool: 'open_session',
      policy: o.policy ?? policies.get(caller) ?? ASK,
      source: 'global',
      args: { path: '/repo', agent: 'claude' },
      prepare: async () => {
        if (o.prepareGate) await o.prepareGate.hold();
        return o.prepareResult ?? { ok: true, value: prepared };
      },
    };
    const out: { result?: Result<string> | null; done: boolean } = { done: false };
    const promise = flow.runControl(c).then((r) => {
      out.result = r;
      out.done = true;
      inflight.end();
      return r;
    });
    return { promise, out, spies, inflight };
  };
  const asks = () =>
    sent.filter(
      (s): s is { to: string; msg: Extract<HostToWebview, { type: 'mcp:ask' }> } =>
        s.msg.type === 'mcp:ask',
    );
  const closed = () => sent.filter((s) => s.msg.type === 'mcp:askClosed').map((s) => s.msg);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    flow,
    call,
    sent,
    asks,
    closed,
    flashed,
    writes,
    owners,
    policies,
    state,
    advance,
    flush,
    timers,
  };
}

const errCode = (r: Result<unknown> | null | undefined) =>
  r === null ? null : r === undefined ? undefined : r.ok ? 'ok' : r.error.code;

/** Answers the only waiting ask from `win`. */
const answerLast = (
  t: ReturnType<typeof setup>,
  flow: CallFlow,
  a: 'approve' | 'deny' | 'always',
  win = 1,
) => {
  const last = t.asks().at(-1);
  if (!last) throw new Error('no ask sent');
  return flow.answer(last.msg.askId, win, a);
};

describe('createCallFlow', () => {
  it('on runs once and returns the result', async () => {
    const t = setup();
    const c = t.call({ policy: ON });
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(c.spies).toEqual({ run: 1, release: 0 });
    expect(t.asks()).toEqual([]);
  });

  it('ask sends mcp:ask to the owner and approve runs once', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    expect(t.asks()).toEqual([
      {
        to: CALLER,
        msg: {
          type: 'mcp:ask',
          askId: 'ask-1',
          callerSessionId: CALLER,
          callerHandle: `claude-${CALLER}`,
          tool: 'open_session',
          summary: { tool: 'open_session', path: '/repo', agent: 'claude', focus: true },
          args: { path: '/repo', agent: 'claude' },
          source: 'global',
        },
      },
    ]);
    expect(t.flashed).toEqual([CALLER]);
    expect(t.flow.awaitingApproval()).toEqual([CALLER]);
    expect(c.spies.run).toBe(0);
    expect(answerLast(t, t.flow, 'approve')).toBe(true);
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(c.spies).toEqual({ run: 1, release: 0 });
    expect(t.flow.awaitingApproval()).toEqual([]);
    expect(t.state.awaitingChanged).toBe(2);
    expect(t.closed()).toEqual([]);
  });

  it('the ask times out after the caller kind’s limit', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.advance(ASK_TIMEOUT_MS.claude - 1);
    await t.flush();
    expect(c.out.done).toBe(false);
    t.advance(1);
    expect(errCode(await c.promise)).toBe('approval_timeout');
  });

  it('deny → denied, token kept', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    answerLast(t, t.flow, 'deny');
    expect(errCode(await c.promise)).toBe('denied');
    expect(c.spies).toEqual({ run: 0, release: 0 });
  });

  it('expired → approval_timeout + askClosed expired', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.advance(ASK_TIMEOUT_MS.claude);
    expect(errCode(await c.promise)).toBe('approval_timeout');
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.closed()).toEqual([{ type: 'mcp:askClosed', askId: 'ask-1', outcome: 'expired' }]);
  });

  it('reply-true cancel → cancelled', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.flow.sessionGone(CALLER);
    expect(errCode(await c.promise)).toBe('cancelled');
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.closed()).toEqual([{ type: 'mcp:askClosed', askId: 'ask-1', outcome: 'cancelled' }]);
  });

  it('reply-false cancel → null', async () => {
    const t = setup();
    const c = t.call({ connId: 4, requestId: 'r' });
    await t.flush();
    t.flow.cancelled(4, 'r');
    expect(await c.promise).toBeNull();
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.closed()).toEqual([{ type: 'mcp:askClosed', askId: 'ask-1', outcome: 'cancelled' }]);
  });

  it('cancel during prepare → no run, released, null', async () => {
    for (const policy of [ON, ASK]) {
      const t = setup();
      const g = gate();
      const c = t.call({ policy, prepareGate: g, requestId: 9 });
      await t.flush();
      t.flow.cancelled(1, 9);
      g.go();
      expect(await c.promise).toBeNull();
      expect(c.spies).toEqual({ run: 0, release: 1 });
      expect(t.asks()).toEqual([]);
    }
  });

  it('cancel during run (on) → null', async () => {
    const t = setup();
    const g = gate();
    const c = t.call({ policy: ON, runGate: g, requestId: 'x' });
    await t.flush();
    expect(c.spies.run).toBe(1);
    t.flow.cancelled(1, 'x');
    g.go();
    expect(await c.promise).toBeNull();
  });

  it('approve then cancel before run → run not called, released, null', async () => {
    const t = setup();
    const c = t.call({ requestId: 5 });
    await t.flush();
    answerLast(t, t.flow, 'approve');
    t.flow.cancelled(1, 5);
    expect(await c.promise).toBeNull();
    expect(c.spies).toEqual({ run: 0, release: 1 });
  });

  it('a prepare refusal is returned as is, with no ask', async () => {
    const t = setup();
    const c = t.call({
      prepareResult: {
        ok: false,
        error: { code: 'path_missing', message: 'no such path', retryable: false },
      },
    });
    expect(errCode(await c.promise)).toBe('path_missing');
    expect(t.asks()).toEqual([]);
  });

  it('always writes the session policy, calls onPolicyWritten, runs', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    answerLast(t, t.flow, 'always');
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(t.writes).toEqual([{ id: CALLER, tool: 'open_session', patch: { access: 'on' } }]);
    expect(t.state.policyWritten).toBe(1);
    expect(c.spies.run).toBe(1);
  });

  it('always after the session is gone → cancelled, run not called', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.policies.delete(CALLER);
    answerLast(t, t.flow, 'always');
    const r = await c.promise;
    expect(errCode(r)).toBe('cancelled');
    expect(r && !r.ok ? r.error.message : '').toBe('the session closed before the request ran');
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.state.policyWritten).toBe(0);
  });

  it('a 4th waiting ask → rate_limited, released, no mcp:ask', async () => {
    const t = setup();
    for (let i = 0; i < MAX_ASKS_PER_CALLER; i++) t.call();
    await t.flush();
    expect(t.asks()).toHaveLength(3);
    const fourth = t.call();
    const r = await fourth.promise;
    expect(errCode(r)).toBe('rate_limited');
    expect(r && !r.ok ? r.error.message : '').toBe(
      'more than 3 requests are waiting for the human',
    );
    expect(fourth.spies).toEqual({ run: 0, release: 1 });
    expect(t.asks()).toHaveLength(3);
    t.call({ caller: 'caller-2' });
    await t.flush();
    expect(t.asks()).toHaveLength(4);
  });

  it('no owner window → window_not_ready, released', async () => {
    const t = setup();
    t.owners.set(CALLER, null);
    const c = t.call();
    expect(errCode(await c.promise)).toBe('window_not_ready');
    expect(c.spies).toEqual({ run: 0, release: 1 });
    expect(t.asks()).toEqual([]);
    expect(t.flashed).toEqual([]);
  });

  it('no await between the cap check and open', async () => {
    const t = setup();
    t.call();
    t.call();
    await t.flush();
    const g = gate();
    const a = t.call({ prepareGate: g });
    const b = t.call({ prepareGate: g });
    await t.flush();
    g.go();
    await t.flush();
    expect(t.asks()).toHaveLength(3);
    const codes = [a.out, b.out].filter((o) => o.done).map((o) => errCode(o.result));
    expect(codes).toEqual(['rate_limited']);
  });

  it('answer from the wrong window is ignored', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    const id = t.asks()[0].msg.askId;
    expect(t.flow.answer(id, 9, 'approve')).toBe(false);
    await t.flush();
    expect(c.out.done).toBe(false);
    expect(t.flow.awaitingApproval()).toEqual([CALLER]);
    expect(t.flow.answer(id, 1, 'approve')).toBe(true);
    expect(errCode(await c.promise)).toBe('ok');
    expect(t.flow.answer(id, 1, 'approve')).toBe(false);
  });

  it('windowReset / sessionGone / sessionMoved end matching asks with cancelled', async () => {
    const t = setup();
    const a = t.call();
    const b = t.call({ caller: 'caller-2' });
    await t.flush();
    t.flow.windowReset(2);
    expect(errCode(await b.promise)).toBe('cancelled');
    expect(a.out.done).toBe(false);
    t.flow.windowReset(1);
    expect(errCode(await a.promise)).toBe('cancelled');

    const c = t.call();
    const d = t.call({ caller: 'caller-2' });
    await t.flush();
    t.flow.sessionMoved(CALLER);
    expect(errCode(await c.promise)).toBe('cancelled');
    await t.flush();
    expect(d.out.done).toBe(false);
    t.flow.sessionGone('caller-2');
    expect(errCode(await d.promise)).toBe('cancelled');
  });

  it('connectionClosed → null', async () => {
    const t = setup();
    const a = t.call({ connId: 3 });
    const b = t.call({ connId: 4 });
    await t.flush();
    t.flow.connectionClosed(3);
    expect(await a.promise).toBeNull();
    await t.flush();
    expect(b.out.done).toBe(false);
  });

  it('recheck cancels asks whose access became off; all when messaging is off', async () => {
    const t = setup();
    const a = t.call();
    const b = t.call({ caller: 'caller-2' });
    await t.flush();
    t.flow.recheck();
    await t.flush();
    expect([a.out.done, b.out.done]).toEqual([false, false]);
    t.policies.set(CALLER, { ...ASK, access: 'off' });
    t.flow.recheck();
    expect(errCode(await a.promise)).toBe('cancelled');
    await t.flush();
    expect(b.out.done).toBe(false);
    t.state.messagingOn = false;
    t.flow.recheck();
    expect(errCode(await b.promise)).toBe('cancelled');
  });

  it('begin with a null requestId is never cancelled', async () => {
    const t = setup();
    const c = t.call({ requestId: null, policy: ON });
    expect(c.inflight.cancelled).toBe(false);
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
  });

  it('end() drops the entry; a later cancel for that id does nothing', () => {
    const t = setup();
    const f = t.flow.begin({ connId: 1, requestId: 7 });
    const other = t.flow.begin({ connId: 2, requestId: 7 });
    f.end();
    f.end();
    t.flow.cancelled(1, 7);
    expect(f.cancelled).toBe(false);
    expect(other.cancelled).toBe(false);
    t.flow.cancelled(2, '7');
    expect(other.cancelled).toBe(false);
    t.flow.cancelled(2, 7);
    expect(other.cancelled).toBe(true);
  });

  it('dispose ends every ask with no reply', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.flow.dispose();
    expect(await c.promise).toBeNull();
  });
});
