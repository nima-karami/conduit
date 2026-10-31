import { describe, expect, it } from 'vitest';
import {
  ASK_TIMEOUT_MS,
  askBudgetMs,
  type CallFlow,
  type ControlCall,
  createCallFlow,
  type InFlight,
  MAX_ASKS_PER_CALLER,
  UI_TIMEOUT_MS,
} from '../../src/conduit-mcp/call-flow';
import type { PreparedCall } from '../../src/conduit-mcp/control-tools';
import type { JsonRpcId } from '../../src/conduit-mcp/json-rpc';
import type {
  CliKind,
  ToolName,
  ToolPolicy,
  ToolPolicyPatch,
} from '../../src/conduit-mcp/tool-policy';
import type { Result } from '../../src/conduit-mcp/types';
import {
  MAX_CLOSE_RESULTS,
  MAX_UI_FAILURE_CHARS,
  type McpUiAction,
} from '../../src/conduit-mcp/ui-types';
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
  const state = { messagingOn: true, policyWritten: 0, awaitingChanged: 0, sendThrows: false };
  const uiSent: Array<{ windowId: number; msg: HostToWebview }> = [];
  const notReady = new Set<number>();
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
    sendToWindow: (windowId, msg) => {
      if (state.sendThrows) throw new Error('render frame disposed');
      uiSent.push({ windowId, msg });
    },
    windowReady: (w) => !notReady.has(w),
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
      kind?: CliKind;
      wiredAtLaunch?: boolean;
      routesUi?: boolean;
      /** Replaces run's body; gets this call's in-flight entry (for flow.requestUi). */
      runBody?: (inflight: InFlight) => Promise<Result<string>>;
    } = {},
  ) => {
    const spies = { run: 0, release: 0 };
    let inflightRef: InFlight | null = null;
    const prepared: PreparedCall<string> = {
      summary: { tool: 'open_session', path: '/repo', agent: 'claude', focus: true },
      routesUi: o.routesUi ?? false,
      run: async () => {
        spies.run++;
        if (o.runGate) await o.runGate.hold();
        if (o.runBody && inflightRef) return o.runBody(inflightRef);
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
    inflightRef = inflight;
    const c: ControlCall<string> = {
      inflight,
      caller: { sessionId: caller, handle: `claude-${caller}` },
      kind: o.kind ?? 'claude',
      wiredAtLaunch: o.wiredAtLaunch ?? false,
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
    uiSent,
    notReady,
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

  it('askBudgetMs: a launch-wired codex waits 170 s; everything else keeps its kind limit', () => {
    expect(askBudgetMs('codex', true)).toBe(170_000);
    expect(askBudgetMs('codex', false)).toBe(ASK_TIMEOUT_MS.codex);
    expect(ASK_TIMEOUT_MS.codex).toBe(50_000);
    for (const kind of ['claude', 'cursor', 'opencode', 'agent'] as const) {
      expect(askBudgetMs(kind, true)).toBe(ASK_TIMEOUT_MS[kind]);
    }
  });

  it('a launch-wired codex ask waits 170 s; a plain-shell codex ask 50 s', async () => {
    const t = setup();
    const wired = t.call({ kind: 'codex', wiredAtLaunch: true });
    const shell = t.call({ kind: 'codex', wiredAtLaunch: false, caller: 'caller-2' });
    await t.flush();
    t.advance(50_000);
    expect(errCode(await shell.promise)).toBe('approval_timeout');
    t.advance(170_000 - 50_000 - 1);
    await t.flush();
    expect(wired.out.done).toBe(false);
    t.advance(1);
    expect(errCode(await wired.promise)).toBe('approval_timeout');
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

  it('approve then cancel before run → run not called, token kept, null', async () => {
    // spec §3.3: a cancelled ask keeps its token, however late the cancel lands.
    for (const a of ['approve', 'always'] as const) {
      const t = setup();
      const c = t.call({ requestId: 5 });
      await t.flush();
      answerLast(t, t.flow, a);
      t.flow.cancelled(1, 5);
      expect(await c.promise).toBeNull();
      expect(c.spies).toEqual({ run: 0, release: 0 });
    }
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
    const g = gate();
    const c = t.call({ requestId: null, policy: ON, runGate: g });
    await t.flush();
    expect(c.spies.run).toBe(1);
    t.flow.connectionClosed(1);
    g.go();
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

describe('mcp:ui waits (spec 2026-10-30-conduit-mcp-app-control §2.3)', () => {
  const OPEN: McpUiAction = { kind: 'openUrl', url: 'http://x/', focus: true };
  const CLOSE_B: McpUiAction = { kind: 'closeSession', target: 'target-b' };
  const CLOSE_ALL: McpUiAction = { kind: 'closeFiles', paths: 'all' };

  /** An 'on' call whose run asks window `w` and reports the UI outcome as its value. */
  function uiCall(
    t: ReturnType<typeof setup>,
    o: {
      w?: number;
      routed?: string;
      action?: McpUiAction;
      requestId?: JsonRpcId | null;
      connId?: number;
    } = {},
  ) {
    return t.call({
      policy: ON,
      routesUi: true,
      requestId: o.requestId,
      connId: o.connId,
      runBody: async (inflight) => {
        const r = await t.flow.requestUi({
          inflight,
          callerSessionId: CALLER,
          routedSessionId: o.routed ?? CALLER,
          windowId: o.w ?? 2,
          action: o.action ?? OPEN,
        });
        return r.ok ? { ok: true, value: JSON.stringify(r.value) } : r;
      },
    });
  }
  const lastUi = (t: ReturnType<typeof setup>) => {
    const m = t.uiSent.at(-1)?.msg;
    if (m?.type !== 'mcp:ui') throw new Error('no mcp:ui sent');
    return m;
  };
  const message = (r: Result<unknown> | null | undefined) =>
    r && !r.ok ? r.error.message : undefined;
  const files = (n: number) => Array.from({ length: n }, (_, i) => `/w/f${i}`);

  it('requestUi sends mcp:ui to the given window and resolves on its answer', async () => {
    const t = setup();
    const c = uiCall(t);
    await t.flush();
    expect(t.uiSent).toEqual([
      {
        windowId: 2,
        msg: { type: 'mcp:ui', requestId: 'ask-1', sessionId: CALLER, action: OPEN },
      },
    ]);
    expect(t.flow.answerUi('ask-1', 2, { kind: 'opened' })).toBe(true);
    expect(await c.promise).toEqual({ ok: true, value: JSON.stringify({ kind: 'opened' }) });
    expect(t.timers.size).toBe(0);
  });

  it('an answer from another window is ignored', async () => {
    const t = setup();
    const c = uiCall(t);
    await t.flush();
    expect(t.flow.answerUi(lastUi(t).requestId, 1, { kind: 'opened' })).toBe(false);
    await t.flush();
    expect(c.out.done).toBe(false);
    expect(t.flow.answerUi(lastUi(t).requestId, 2, { kind: 'opened' })).toBe(true);
    expect(errCode(await c.promise)).toBe('ok');
  });

  it('a malformed answer is ignored', async () => {
    const bad: [McpUiAction, unknown][] = [
      [CLOSE_ALL, { kind: 'closeFiles' }],
      [CLOSE_B, { kind: 'closeSession', ok: false, unsaved: files(21) }],
      [CLOSE_B, { kind: 'closeSession', ok: false, unsaved: [1] }],
      [CLOSE_B, { kind: 'closeSession', ok: false, unsaved: [] }],
      [CLOSE_B, { kind: 'closeSession', ok: 'yes' }],
      [OPEN, { kind: 'failed' }],
      [OPEN, { kind: 'failed', message: 3 }],
      [CLOSE_B, { kind: 'opened' }],
      [OPEN, { kind: 'closeSession', ok: true }],
      [OPEN, null],
      [OPEN, 'opened'],
      [
        CLOSE_ALL,
        {
          kind: 'closeFiles',
          closed: files(MAX_CLOSE_RESULTS),
          skipped: [{ path: '/x', reason: 'not_open' }],
        },
      ],
      [CLOSE_ALL, { kind: 'closeFiles', closed: [], skipped: [{ path: '/x', reason: 'locked' }] }],
      [CLOSE_ALL, { kind: 'closeFiles', closed: [], skipped: [], truncated: false }],
    ];
    for (const [action, raw] of bad) {
      const t = setup();
      const c = uiCall(t, { action });
      await t.flush();
      expect(t.flow.answerUi(lastUi(t).requestId, 2, raw)).toBe(false);
      await t.flush();
      expect(c.out.done).toBe(false);
    }
  });

  it('well-formed answers parse per kind, unknownSession for any kind', async () => {
    const good: [McpUiAction, unknown, unknown][] = [
      [CLOSE_B, { kind: 'closeSession', ok: true }, { kind: 'closeSession', ok: true }],
      [
        CLOSE_B,
        { kind: 'closeSession', ok: false, unsaved: ['/w/a'], extra: 1 },
        { kind: 'closeSession', ok: false, unsaved: ['/w/a'] },
      ],
      [
        CLOSE_ALL,
        {
          kind: 'closeFiles',
          closed: files(MAX_CLOSE_RESULTS - 1),
          skipped: [{ path: '/w/b', reason: 'unsaved' }],
          truncated: true,
        },
        {
          kind: 'closeFiles',
          closed: files(MAX_CLOSE_RESULTS - 1),
          skipped: [{ path: '/w/b', reason: 'unsaved' }],
          truncated: true,
        },
      ],
      [
        CLOSE_ALL,
        { kind: 'closeFiles', closed: [], skipped: [] },
        { kind: 'closeFiles', closed: [], skipped: [] },
      ],
      [OPEN, { kind: 'opened' }, { kind: 'opened' }],
      [CLOSE_B, { kind: 'unknownSession' }, { kind: 'unknownSession' }],
      [OPEN, { kind: 'unknownSession' }, { kind: 'unknownSession' }],
      [OPEN, { kind: 'failed', message: 'm' }, { kind: 'failed', message: 'm' }],
      [
        CLOSE_ALL,
        { kind: 'failed', message: 'x'.repeat(MAX_UI_FAILURE_CHARS + 5) },
        { kind: 'failed', message: 'x'.repeat(MAX_UI_FAILURE_CHARS) },
      ],
      // Control characters never reach the agent; tab and newline stay.
      [
        OPEN,
        { kind: 'failed', message: 'a\x1b[2Jb\x00c\x7fd\te\nf\x08' },
        { kind: 'failed', message: 'a[2Jbcd\te\nf' },
      ],
      // C1 too: \u009b is a one-byte CSI.
      [
        OPEN,
        { kind: 'failed', message: 'x\u009b2Jy\u0080z\u009f! ' },
        { kind: 'failed', message: 'x2Jyz! ' },
      ],
    ];
    for (const [action, raw, want] of good) {
      const t = setup();
      const c = uiCall(t, { action });
      await t.flush();
      expect(t.flow.answerUi(lastUi(t).requestId, 2, raw)).toBe(true);
      expect(await c.promise).toStrictEqual({ ok: true, value: JSON.stringify(want) });
    }
  });

  it('an unready window → window_not_ready, nothing sent, nothing pending', async () => {
    const t = setup();
    t.notReady.add(2);
    const c = uiCall(t);
    const r = await c.promise;
    expect(errCode(r)).toBe('window_not_ready');
    expect(message(r)).toBe("this session's Conduit window isn't ready; try again shortly");
    expect(t.uiSent).toEqual([]);
    expect(t.timers.size).toBe(0);
  });

  it('a throwing sendToWindow → window_not_ready, nothing pending, no timer left', async () => {
    const t = setup();
    t.state.sendThrows = true;
    const c = uiCall(t);
    expect(errCode(await c.promise)).toBe('window_not_ready');
    expect(t.timers.size).toBe(0);
    expect(t.flow.answerUi('ask-1', 2, { kind: 'opened' })).toBe(false);
  });

  it('5 s → ui_timeout; a late answer → false', async () => {
    const t = setup();
    const c = uiCall(t);
    await t.flush();
    t.advance(UI_TIMEOUT_MS - 1);
    await t.flush();
    expect(c.out.done).toBe(false);
    t.advance(1);
    const r = await c.promise;
    expect(errCode(r)).toBe('ui_timeout');
    expect(r && !r.ok ? r.error.retryable : true).toBe(false);
    expect(message(r)).toBe("Conduit's window didn't answer within 5 s; the outcome is unknown");
    expect(t.flow.answerUi('ask-1', 2, { kind: 'opened' })).toBe(false);
  });

  it('windowReset(2) → window_not_ready; sessionMoved(caller) → window_not_ready', async () => {
    const t = setup();
    const a = uiCall(t);
    const other = uiCall(t, { w: 1 });
    await t.flush();
    t.flow.windowReset(2);
    const r = await a.promise;
    expect(errCode(r)).toBe('window_not_ready');
    expect(message(r)).toBe(
      "Conduit's window closed or reloaded before answering; the outcome is unknown",
    );
    await t.flush();
    expect(other.out.done).toBe(false);
    t.flow.sessionMoved(CALLER);
    expect(errCode(await other.promise)).toBe('window_not_ready');
  });

  it('sessionGone(routed target ≠ caller) ends a closeSession wait', async () => {
    const t = setup();
    const c = uiCall(t, { routed: 'target-b', action: CLOSE_B });
    const unrelated = uiCall(t, {
      routed: 'target-c',
      action: { kind: 'closeSession', target: 'target-c' },
    });
    await t.flush();
    t.flow.sessionGone('target-b');
    expect(errCode(await c.promise)).toBe('window_not_ready');
    await t.flush();
    expect(unrelated.out.done).toBe(false);
    t.flow.sessionMoved('target-c');
    expect(errCode(await unrelated.promise)).toBe('window_not_ready');
  });

  it('notifications/cancelled ends the UI wait and runControl returns null', async () => {
    const t = setup();
    const c = uiCall(t, { connId: 5, requestId: 'q' });
    await t.flush();
    expect(t.uiSent).toHaveLength(1);
    t.flow.cancelled(5, 'q');
    expect(await c.promise).toBeNull();
    expect(t.timers.size).toBe(0);
    expect(t.flow.answerUi(lastUi(t).requestId, 2, { kind: 'opened' })).toBe(false);
  });

  it('connectionClosed ends UI waits', async () => {
    const t = setup();
    const c = uiCall(t, { connId: 6 });
    const other = uiCall(t, { connId: 7 });
    await t.flush();
    t.flow.connectionClosed(6);
    expect(await c.promise).toBeNull();
    expect(t.timers.size).toBe(1);
    await t.flush();
    expect(other.out.done).toBe(false);
  });

  it('recheck leaves UI waits alone', async () => {
    const t = setup();
    const c = uiCall(t);
    await t.flush();
    t.state.messagingOn = false;
    t.flow.recheck();
    await t.flush();
    expect(c.out.done).toBe(false);
    expect(t.flow.answerUi(lastUi(t).requestId, 2, { kind: 'opened' })).toBe(true);
    expect(errCode(await c.promise)).toBe('ok');
  });

  it('dispose ends both', async () => {
    const t = setup();
    const ui = uiCall(t);
    const asked = t.call();
    await t.flush();
    t.flow.dispose();
    expect(await asked.promise).toBeNull();
    expect(errCode(await ui.promise)).toBe('window_not_ready');
    expect(t.timers.size).toBe(0);
  });

  it('a UI-routed ask waits ASK_TIMEOUT_MS[kind] − 5 s', async () => {
    expect(ASK_TIMEOUT_MS.agent - UI_TIMEOUT_MS).toBe(20_000);
    const t = setup();
    const ui = t.call({ kind: 'agent', routesUi: true });
    const plain = t.call({ kind: 'agent', routesUi: false });
    await t.flush();
    t.advance(20_000 - 1);
    await t.flush();
    expect(ui.out.done).toBe(false);
    t.advance(1);
    expect(errCode(await ui.promise)).toBe('approval_timeout');
    await t.flush();
    expect(plain.out.done).toBe(false);
    t.advance(5_000);
    expect(errCode(await plain.promise)).toBe('approval_timeout');
  });

  it('the ask deadline counts from the call’s begin, so a slow prepare shortens it', async () => {
    const t = setup();
    const slow = gate();
    const ui = t.call({ kind: 'agent', routesUi: true, prepareGate: slow });
    await t.flush();
    t.advance(8_000);
    slow.go();
    await t.flush();
    expect(t.asks()).toHaveLength(1);
    t.advance(12_000 - 1);
    await t.flush();
    expect(ui.out.done).toBe(false);
    t.advance(1);
    await t.flush();
    expect(ui.out.done).toBe(true);
    expect(errCode(await ui.promise)).toBe('approval_timeout');
  });

  it('a prepare that used the whole ask budget → approval_timeout, no card, token released', async () => {
    const t = setup();
    const slow = gate();
    const ui = t.call({ kind: 'agent', routesUi: true, prepareGate: slow });
    await t.flush();
    t.advance(20_000);
    slow.go();
    await t.flush();
    expect(ui.out.done).toBe(true);
    expect(errCode(await ui.promise)).toBe('approval_timeout');
    expect(t.asks()).toHaveLength(0);
    expect(ui.spies.release).toBe(1);
    expect(t.timers.size).toBe(0);
  });
});
