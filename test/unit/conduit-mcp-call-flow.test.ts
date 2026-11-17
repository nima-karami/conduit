import { describe, expect, it } from 'vitest';
import {
  type AnswerDecision,
  ASK_TIMEOUT_MS,
  askBudgetMs,
  type CallFlow,
  type ControlCall,
  createCallFlow,
  type GrantOutcome,
  type InFlight,
  MAX_ASKS_PER_CALLER,
  NO_OWNER_WINDOW,
  type PermissionEnd,
  type PermissionRaise,
  UI_TIMEOUT_MS,
} from '../../src/conduit-mcp/call-flow';
import type { Prepared, PreparedCall } from '../../src/conduit-mcp/control-tools';
import type { GrantChoice } from '../../src/conduit-mcp/grant-store';
import type { JsonRpcId } from '../../src/conduit-mcp/json-rpc';
import type {
  Grant,
  OneUseOverride,
  PolicyCommitError,
  PolicyDecision,
} from '../../src/conduit-mcp/policy-types';
import type { CliKind } from '../../src/conduit-mcp/tool-policy';
import type { Result } from '../../src/conduit-mcp/types';
import {
  MAX_CLOSE_RESULTS,
  MAX_UI_FAILURE_CHARS,
  type McpUiAction,
} from '../../src/conduit-mcp/ui-types';
import type { HostToWebview } from '../../src/protocol';

const CALLER = 'caller-1';
const ASK: PolicyDecision = {
  decision: 'ask',
  reason: { by: 'profile', point: { kind: 'default' }, profileId: 'worker' },
  rule: { when: 'viewing', move: 'yes', reach: null },
  grantId: null,
  overrideId: null,
  grantIds: [],
  overrideIds: [],
  deniedTarget: null,
  forcedAsk: false,
};
const ON: PolicyDecision = { ...ASK, decision: 'allow' };
const HELD: OneUseOverride = {
  id: 'ov-held',
  sessionId: CALLER,
  tool: 'open_session',
  target: { sessionId: null, path: null, folder: null, projectId: null },
  createdAt: '2026-11-15T00:00:00.000Z',
};
const CREATED: Grant = {
  id: 'new-grant',
  who: { kind: 'session', sessionId: CALLER },
  tool: 'open_session',
  on: { kind: 'anywhere' },
  for: 'session-end',
  anchorSessionId: CALLER,
  createdAt: '2026-11-15T00:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  state: 'active',
  endedAt: null,
  requestId: 'perm-1',
};
const ALWAYS_GRANT: GrantChoice = { who: 'session', on: 'anywhere', for: 'session-end' };

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
  const permissions: PermissionRaise[] = [];
  const settled: PermissionEnd[] = [];
  const reDecides: string[][] = [];
  const grants: Array<{ choice: GrantChoice; requestId: string }> = [];
  const answerCommits: string[][] = [];
  const cleanupIds: string[][] = [];
  let perm = 0;
  const owners = new Map<string, number | null>([
    [CALLER, 1],
    ['caller-2', 2],
  ]);
  const policies = new Map<string, PolicyDecision>([
    [CALLER, ASK],
    ['caller-2', ASK],
  ]);
  const state = {
    messagingOn: true,
    appUp: true,
    redecide: { kind: 'ready' } as AnswerDecision,
    grantOutcome: { ok: true, grants: [CREATED] } as GrantOutcome,
    commitOk: true,
    commitError: null as PolicyCommitError | null,
    throwAt: '',
    cleanupThrows: false,
    awaitingChanged: 0,
    sendThrows: false,
  };
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
    appConnected: () => state.appUp,
    sendToOwner: (to, msg) => sent.push({ to, msg }),
    flashOwner: (id) => flashed.push(id),
    stillVisible: (id) => policies.has(id) && policies.get(id)?.decision !== 'deny',
    messagingOn: () => state.messagingOn,
    openPermission: (r) => {
      permissions.push(r);
      return `perm-${++perm}`;
    },
    settlePermission: (e) => {
      if (state.throwAt === 'settle') throw new Error('broken settle');
      settled.push(e);
    },
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
      policy?: PolicyDecision;
      requestId?: JsonRpcId | null;
      connId?: number;
      prepareGate?: ReturnType<typeof gate>;
      runGate?: ReturnType<typeof gate>;
      prepareResult?: Result<Prepared<string>>;
      commitResult?: boolean;
      commitTo?: PolicyDecision;
      held?: OneUseOverride[];
      redecide?: AnswerDecision;
      denyReason?: string;
      grantOutcome?: GrantOutcome;
      commitOk?: boolean;
      kind?: CliKind;
      wiredAtLaunch?: boolean;
      routesUi?: boolean;
      alwaysAsk?: boolean;
      /** Replaces run's body; gets this call's in-flight entry (for flow.requestUi). */
      runBody?: (inflight: InFlight) => Promise<Result<string>>;
    } = {},
  ) => {
    const spies = { run: 0, release: 0 };
    const commits = { n: 0 };
    const events: string[] = [];
    let inflightRef: InFlight | null = null;
    const prepared: PreparedCall<string> = {
      summary: { tool: 'open_session', path: '/repo', agent: 'claude', focus: true },
      routesUi: o.routesUi ?? false,
      alwaysAsk: o.alwaysAsk ?? false,
      run: async () => {
        spies.run++;
        events.push('run');
        if (o.runGate) await o.runGate.hold();
        if (o.runBody && inflightRef) return o.runBody(inflightRef);
        return { ok: true, value: 'opened' };
      },
      release: () => {
        spies.release++;
      },
    };
    const caller = o.caller ?? CALLER;
    const decision = o.policy ?? policies.get(caller) ?? ASK;
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
      decision,
      commit: () => {
        commits.n++;
        events.push('commit');
        if (o.commitResult === false) return { ok: false, error: 'policy-changed' };
        return { ok: true, decision: o.commitTo ?? decision, held: o.held ?? [] };
      },
      permission: { why: 'the policy asks', targets: [], grantable: true },
      denyReason: () => o.denyReason ?? null,
      reDecide: (held) => {
        if (state.throwAt === 'reDecide') throw new Error('broken reDecide');
        reDecides.push(held.map((h) => h.id));
        return o.redecide ?? state.redecide;
      },
      grant: (choice, requestId) => {
        if (state.throwAt === 'grant') throw new Error('broken grant');
        grants.push({ choice, requestId });
        return o.grantOutcome ?? state.grantOutcome;
      },
      commitAnswered: (held) => {
        if (state.throwAt === 'commit') throw new Error('broken commit');
        answerCommits.push(held.map((h) => h.id));
        if (state.commitError !== null) return { ok: false, error: state.commitError };
        return (o.commitOk ?? state.commitOk)
          ? { ok: true, overrides: [] }
          : { ok: false, error: 'policy-changed' };
      },
      revokeCreatedGrants: (ids) => {
        cleanupIds.push([...ids]);
        if (state.cleanupThrows) throw new Error('broken cleanup');
        return { ok: true };
      },
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
    return { promise, out, spies, inflight, commits, events };
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
    permissions,
    settled,
    reDecides,
    grants,
    answerCommits,
    cleanupIds,
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

  it('a bare command asks even under an on policy; deny refuses and runs nothing', async () => {
    const t = setup();
    const c = t.call({ policy: ON, alwaysAsk: true });
    await t.flush();
    expect(t.asks()).toHaveLength(1);
    answerLast(t, t.flow, 'deny');
    expect(await c.promise).toMatchObject({ ok: false });
    expect(c.spies.run).toBe(0);
  });

  it('a registered call under an on policy does not ask', async () => {
    const t = setup();
    const c = t.call({ policy: ON, alwaysAsk: false });
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
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
          askId: 'perm-1',
          callerSessionId: CALLER,
          callerHandle: `claude-${CALLER}`,
          tool: 'open_session',
          summary: { tool: 'open_session', path: '/repo', agent: 'claude', focus: true },
          args: { path: '/repo', agent: 'claude' },
          source: 'global',
          grantable: true,
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

  it('a done answer shows no card under ask, and off still refuses it', async () => {
    const t = setup();
    const done: Result<string> = { ok: true, value: 'answered' };
    const onAsk = t.call({ policy: ASK, prepareResult: { ok: true, value: { done } } });
    expect(await onAsk.promise).toEqual(done);
    expect(t.asks()).toEqual([]);
    const onOn = t.call({ policy: ON, prepareResult: { ok: true, value: { done } } });
    expect(await onOn.promise).toEqual(done);
    const off = t.call({
      policy: { ...ASK, decision: 'deny' },
      prepareResult: { ok: true, value: { done } },
    });
    expect(await off.promise).toEqual({
      ok: false,
      error: {
        code: 'tool_disabled',
        message: 'open_session is not enabled for this session',
        retryable: false,
        hint: 'Turn on open_session in Settings → MCP (it is off for this session or CLI)',
      },
    });
    expect(t.asks()).toEqual([]);
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
    expect(t.closed()).toEqual([{ type: 'mcp:askClosed', askId: 'perm-1', outcome: 'expired' }]);
  });

  it('reply-true cancel → cancelled', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.flow.sessionGone(CALLER);
    expect(errCode(await c.promise)).toBe('cancelled');
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.closed()).toEqual([{ type: 'mcp:askClosed', askId: 'perm-1', outcome: 'cancelled' }]);
  });

  it('reply-false cancel → null', async () => {
    const t = setup();
    const c = t.call({ connId: 4, requestId: 'r' });
    await t.flush();
    t.flow.cancelled(4, 'r');
    expect(await c.promise).toBeNull();
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.closed()).toEqual([{ type: 'mcp:askClosed', askId: 'perm-1', outcome: 'cancelled' }]);
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

  it('card always → session-end anywhere grant, re-decided, then runs', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    answerLast(t, t.flow, 'always');
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(t.reDecides).toHaveLength(1);
    expect(t.grants).toEqual([{ choice: ALWAYS_GRANT, requestId: 'perm-1' }]);
    expect(c.spies.run).toBe(1);
  });

  it('card approve → re-decided with no grant, then runs', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    answerLast(t, t.flow, 'approve');
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(t.grants).toEqual([]);
  });

  it('a grant the re-decide refuses (session gone) → cancelled, run not called', async () => {
    const t = setup();
    const c = t.call({ grantOutcome: { ok: false, error: 'session-gone' } });
    await t.flush();
    answerLast(t, t.flow, 'always');
    const r = await c.promise;
    expect(errCode(r)).toBe('cancelled');
    expect(r && !r.ok ? r.error.message : '').toBe('the session closed before the request ran');
    expect(c.spies).toEqual({ run: 0, release: 0 });
  });

  it('a denied answer reason reaches the declined error, with its control characters removed', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.flow.answerPermission('perm-1', { outcome: 'denied', reason: 'too risky\u001b[31m now' }, 1);
    const r = await c.promise;
    expect(errCode(r)).toBe('denied');
    expect(r && !r.ok ? r.error.message : '').toBe(
      'the human declined the request: too risky[31m now',
    );
  });

  it('a denied answer with no reason keeps the plain declined message', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.flow.answerPermission('perm-1', { outcome: 'denied' }, 1);
    const r = await c.promise;
    expect(r && !r.ok ? r.error.message : '').toBe('the human declined the request');
  });

  it('a recheck that finds the policy denying the ask withdraws it with that reason; the call is tool_disabled', async () => {
    const t = setup();
    const c = t.call({ denyReason: 'Observer: deny' });
    await t.flush();
    t.policies.delete(CALLER);
    t.flow.recheck();
    const r = await c.promise;
    expect(errCode(r)).toBe('tool_disabled');
    expect(r && !r.ok ? r.error.message : '').toBe('Observer: deny');
    expect(t.settled).toMatchObject([{ end: 'withdrawn', reason: 'Observer: deny' }]);
    expect(c.spies.run).toBe(0);
  });

  it('a recheck that cancels an ask the policy still allows keeps it cancelled', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.policies.delete(CALLER);
    t.flow.recheck();
    expect(errCode(await c.promise)).toBe('cancelled');
    expect(t.settled).toMatchObject([{ end: 'withdrawn', reason: 'the call was cancelled' }]);
  });

  it('a grant scope that does not resolve ends the ask withdrawn with that reason, creating nothing more', async () => {
    const t = setup();
    const c = t.call({ grantOutcome: { ok: false, error: 'scope' } });
    await t.flush();
    answerLast(t, t.flow, 'always');
    const r = await c.promise;
    expect(r && !r.ok ? r.error.message : '').toBe("that scope isn't available for every target");
    expect(t.settled).toMatchObject([
      { end: 'withdrawn', reason: "that scope isn't available for every target" },
    ]);
    expect(c.spies.run).toBe(0);
  });

  it('a deny at the re-decide creates no grant, even for always', async () => {
    const t = setup();
    const c = t.call({ redecide: { kind: 'withdraw', reason: 'Observer: deny' } });
    await t.flush();
    answerLast(t, t.flow, 'always');
    expect(errCode(await c.promise)).toBe('tool_disabled');
    expect(t.grants).toEqual([]);
    expect(t.answerCommits).toEqual([]);
    expect(c.spies.run).toBe(0);
  });

  it('ask creates one permission request whose id is the askId', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    expect(t.permissions).toHaveLength(1);
    expect(t.asks().map((a) => a.msg.askId)).toEqual(['perm-1']);
    expect(t.permissions[0]).toMatchObject({
      caller: { sessionId: CALLER, handle: `claude-${CALLER}` },
      tool: 'open_session',
      why: 'the policy asks',
      targets: [],
      expiresAt: 1000 + ASK_TIMEOUT_MS.claude,
    });
    answerLast(t, t.flow, 'deny');
    await c.promise;
  });

  it('deny settles the permission answered as denied and runs nothing', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    answerLast(t, t.flow, 'deny');
    expect(errCode(await c.promise)).toBe('denied');
    expect(t.settled).toEqual([
      {
        requestId: 'perm-1',
        caller: { sessionId: CALLER, handle: `claude-${CALLER}` },
        tool: 'open_session',
        end: 'answered',
        answer: { outcome: 'denied' },
        by: { kind: 'you', windowId: 1 },
        reason: null,
      },
    ]);
    expect(t.reDecides).toEqual([]);
  });

  it('approve settles the permission answered as allowed, after the re-decide', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    answerLast(t, t.flow, 'approve');
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(t.settled).toHaveLength(1);
    expect(t.settled[0]).toMatchObject({
      requestId: 'perm-1',
      end: 'answered',
      answer: { outcome: 'allowed' },
    });
  });

  it("expiry leaves the permission to the queue's timer and returns approval_timeout", async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.advance(ASK_TIMEOUT_MS.claude);
    expect(errCode(await c.promise)).toBe('approval_timeout');
    expect(t.settled).toEqual([]);
  });

  it('a cancel settles the permission withdrawn, with the cancel as its reason', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    t.flow.sessionGone(CALLER);
    expect(errCode(await c.promise)).toBe('cancelled');
    expect(t.settled).toMatchObject([
      { requestId: 'perm-1', end: 'withdrawn', answer: null, reason: 'the call was cancelled' },
    ]);
  });

  it('a policy turned deny while the card waits → withdrawn with its reason, call tool_disabled', async () => {
    const t = setup();
    const c = t.call({ redecide: { kind: 'withdraw', reason: 'Lead: deny' } });
    await t.flush();
    answerLast(t, t.flow, 'approve');
    const r = await c.promise;
    expect(errCode(r)).toBe('tool_disabled');
    expect(r && !r.ok ? r.error.message : '').toBe('Lead: deny');
    expect(c.spies.run).toBe(0);
    expect(t.settled).toMatchObject([{ end: 'withdrawn', reason: 'Lead: deny' }]);
  });

  it('a policy turned allow while the card waits does not run until it is answered', async () => {
    const t = setup();
    const c = t.call({ policy: ASK });
    await t.flush();
    t.policies.set(CALLER, ON);
    t.flush();
    expect(c.spies.run).toBe(0);
    expect(t.reDecides).toEqual([]);
    answerLast(t, t.flow, 'approve');
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(c.spies.run).toBe(1);
  });

  it('the override records the commit held go to the re-decide by id', async () => {
    const t = setup();
    const c = t.call({ held: [HELD] });
    await t.flush();
    answerLast(t, t.flow, 'approve');
    await c.promise;
    expect(t.reDecides[0]).toEqual(['ov-held']);
  });

  it('acknowledges a durable answer before waiting for the tool to finish', async () => {
    const t = setup();
    const runGate = gate();
    const c = t.call({ runGate });
    await t.flush();
    const result = await t.flow.answerPermission(
      'perm-1',
      { outcome: 'allowed', grant: ALWAYS_GRANT },
      1,
    );
    expect(result).toEqual({ ok: true });
    expect(runGate.held).toBe(true);
    expect(c.out.done).toBe(false);
    runGate.go();
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
  });

  it('returns a commit IO failure without creating or running new authority', async () => {
    const t = setup();
    t.state.commitError = 'save-failed';
    const c = t.call();
    await t.flush();
    expect(
      await t.flow.answerPermission('perm-1', { outcome: 'allowed', grant: ALWAYS_GRANT }, 1),
    ).toEqual({
      ok: false,
      reason: 'not_answerable',
      message: 'Permissions could not be saved (save-failed)',
    });
    expect(t.grants).toEqual([]);
    expect(c.spies.run).toBe(0);
    expect(errCode(await c.promise)).toBe('policy_unavailable');
  });

  it.each(['reDecide', 'commit', 'grant', 'settle'])(
    'refuses the receipt and propagates a throwing %s producer',
    async (stage) => {
      const t = setup();
      const c = t.call();
      const failed = c.promise.catch((error: unknown) => error);
      await t.flush();
      t.state.throwAt = stage;
      const receipt = t.flow.answerPermission(
        'perm-1',
        { outcome: 'allowed', grant: ALWAYS_GRANT },
        1,
      );
      expect(await receipt).toEqual({
        ok: false,
        reason: 'not_answerable',
        message: 'Permission answer failed before the action ran',
      });
      expect(await failed).toEqual(new Error(`broken ${stage}`));
      expect(c.spies.run).toBe(0);
      expect(t.cleanupIds).toEqual(stage === 'settle' ? [['new-grant']] : []);
    },
  );

  it('preserves settlement and cleanup exceptions while refusing the receipt', async () => {
    const t = setup();
    const c = t.call();
    const failed = c.promise.catch((error: unknown) => error);
    await t.flush();
    t.state.throwAt = 'settle';
    t.state.cleanupThrows = true;
    const receipt = t.flow.answerPermission(
      'perm-1',
      { outcome: 'allowed', grant: ALWAYS_GRANT },
      1,
    );
    expect((await receipt).ok).toBe(false);
    const error = await failed;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('missing aggregate');
    expect(error.errors).toEqual([new Error('broken settle'), new Error('broken cleanup')]);
    expect(c.spies.run).toBe(0);
    expect(t.cleanupIds).toEqual([['new-grant']]);
  });

  it('does not create a grant when the answered commit refuses', async () => {
    const t = setup();
    const c = t.call({ commitOk: false });
    await t.flush();
    const receipt = await t.flow.answerPermission(
      'perm-1',
      { outcome: 'allowed', grant: ALWAYS_GRANT },
      1,
    );
    expect(receipt.ok).toBe(false);
    expect(t.grants).toEqual([]);
    expect(c.spies.run).toBe(0);
    await c.promise;
  });

  it('returns the grant persistence failure instead of acknowledging an accepted queue item', async () => {
    const t = setup();
    const c = t.call({ grantOutcome: { ok: false, error: 'save-failed' } });
    await t.flush();
    expect(
      await t.flow.answerPermission('perm-1', { outcome: 'allowed', grant: ALWAYS_GRANT }, 1),
    ).toEqual({
      ok: false,
      reason: 'not_answerable',
      message: 'Permissions could not be saved (save-failed)',
    });
    expect(errCode(await c.promise)).toBe('cancelled');
    expect(c.spies.run).toBe(0);
    expect(t.settled).toMatchObject([{ end: 'withdrawn', answer: null }]);
  });

  it.each(['cancel', 'dispose', 'gone', 'window'] as const)(
    'settles answer receipt on %s before continuation without executing',
    async (how) => {
      const t = setup();
      const c = t.call({ connId: 1, requestId: 'call' });
      await t.flush();
      const receipt = t.flow.answerPermission(
        'perm-1',
        { outcome: 'allowed', grant: ALWAYS_GRANT },
        1,
      );
      if (how === 'cancel') t.flow.cancelled(1, 'call');
      else if (how === 'dispose') t.flow.dispose();
      else if (how === 'gone') t.flow.sessionGone(CALLER);
      else t.flow.windowReset(1);
      expect(await receipt).toMatchObject({ ok: false, reason: 'not_answerable' });
      expect(await c.promise).toBeNull();
      expect(c.spies.run).toBe(0);
      expect(t.grants).toHaveLength(0);
    },
  );

  it('returns the policy redecision or consume failure to the answer owner', async () => {
    for (const mode of ['redecision', 'consume'] as const) {
      const t = setup();
      const c = t.call(
        mode === 'redecision'
          ? { redecide: { kind: 'withdraw', reason: 'new deny' } }
          : { commitOk: false },
      );
      await t.flush();
      expect(await t.flow.answerPermission('perm-1', { outcome: 'allowed' }, 1)).toEqual({
        ok: false,
        reason: 'not_answerable',
        message: mode === 'redecision' ? 'new deny' : 'the policy changed while the request waited',
      });
      expect(c.spies.run).toBe(0);
      await c.promise;
    }
  });

  it("answerPermission from a window that is not the ask's owner is refused and the ask keeps waiting", async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    expect(await t.flow.answerPermission('perm-1', { outcome: 'denied' }, 2)).toEqual({
      ok: false,
      reason: 'not_answerable',
      message: 'nothing is waiting on this request',
    });
    expect(t.asks()).toHaveLength(1);
    expect(c.out.done).toBe(false);
    expect(await t.flow.answerPermission('perm-1', { outcome: 'denied' }, 1)).toEqual({ ok: true });
    expect(errCode(await c.promise)).toBe('denied');
    expect(t.closed()).toContainEqual({
      type: 'mcp:askClosed',
      askId: 'perm-1',
      outcome: 'answered',
    });
  });

  it('answerPermission from a sender with no known window (NO_OWNER_WINDOW) is refused', async () => {
    const t = setup();
    t.owners.set(CALLER, null);
    t.state.appUp = false;
    const c = t.call();
    await t.flush();
    expect(await t.flow.answerPermission('perm-1', { outcome: 'denied' }, NO_OWNER_WINDOW)).toEqual(
      { ok: false, reason: 'not_answerable', message: 'nothing is waiting on this request' },
    );
    expect(c.out.done).toBe(false);
    t.advance(ASK_TIMEOUT_MS.claude);
    expect(errCode(await c.promise)).toBe('approval_timeout');
  });

  it('answerPermission ends a live ask with the given answer; an unknown id is false', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    expect(await t.flow.answerPermission('perm-missing', { outcome: 'denied' }, 1)).toEqual({
      ok: false,
      reason: 'not_answerable',
      message: 'nothing is waiting on this request',
    });
    expect(await t.flow.answerPermission('perm-1', { outcome: 'denied' }, 1)).toEqual({ ok: true });
    expect(errCode(await c.promise)).toBe('denied');
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

  it('an allowed call commits once, before it runs', async () => {
    const t = setup();
    const c = t.call({ policy: ON });
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(c.commits.n).toBe(1);
    expect(c.events).toEqual(['commit', 'run']);
  });

  it('an ask commits once when its card is raised, and an approved run does not commit again', async () => {
    const t = setup();
    const c = t.call();
    await t.flush();
    expect(c.commits.n).toBe(1);
    answerLast(t, t.flow, 'approve');
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(c.commits.n).toBe(1);
    expect(c.events).toEqual(['commit', 'run']);
  });

  it('a call refused before its card or run never commits', async () => {
    const t = setup();
    for (let i = 0; i < MAX_ASKS_PER_CALLER; i++) t.call();
    await t.flush();
    const rateLimited = t.call();
    expect(errCode(await rateLimited.promise)).toBe('rate_limited');
    expect(rateLimited.commits.n).toBe(0);

    const denied = t.call({ policy: { ...ASK, decision: 'deny' } });
    expect(errCode(await denied.promise)).toBe('tool_disabled');
    expect(denied.commits.n).toBe(0);

    const prepareFailed = t.call({
      prepareResult: {
        ok: false,
        error: { code: 'path_missing', message: 'no such path', retryable: false },
      },
    });
    expect(errCode(await prepareFailed.promise)).toBe('path_missing');
    expect(prepareFailed.commits.n).toBe(0);

    const fresh = setup();
    fresh.owners.set(CALLER, null);
    const notReady = fresh.call();
    expect(errCode(await notReady.promise)).toBe('window_not_ready');
    expect(notReady.commits.n).toBe(0);
  });

  it('a done answer commits when the decision is not deny, and a deny never does', async () => {
    const t = setup();
    const done: Result<string> = { ok: true, value: 'answered' };
    const on = t.call({ policy: ON, prepareResult: { ok: true, value: { done } } });
    expect(await on.promise).toEqual(done);
    expect(on.commits.n).toBe(1);
    const off = t.call({
      policy: { ...ASK, decision: 'deny' },
      prepareResult: { ok: true, value: { done } },
    });
    expect(errCode(await off.promise)).toBe('tool_disabled');
    expect(off.commits.n).toBe(0);
  });

  it('a commit that finds its override spent runs nothing and refuses as tool_disabled', async () => {
    const t = setup();
    const allowed = t.call({ policy: ON, commitResult: false });
    expect(errCode(await allowed.promise)).toBe('tool_disabled');
    expect(allowed.spies).toEqual({ run: 0, release: 1 });

    const asked = t.call({ commitResult: false });
    expect(errCode(await asked.promise)).toBe('tool_disabled');
    expect(asked.spies).toEqual({ run: 0, release: 1 });
    expect(t.asks()).toEqual([]);
  });

  it('a done answer whose commit finds its override spent refuses as tool_disabled and runs nothing', async () => {
    const t = setup();
    const done: Result<string> = { ok: true, value: 'answered' };
    const c = t.call({
      policy: ON,
      commitResult: false,
      prepareResult: { ok: true, value: { done } },
    });
    expect(errCode(await c.promise)).toBe('tool_disabled');
    expect(c.commits.n).toBe(1);
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.asks()).toEqual([]);
  });

  it('a spent ask whose commit recovers an allow runs without a card', async () => {
    const t = setup();
    const c = t.call({ commitTo: ON });
    expect(await c.promise).toEqual({ ok: true, value: 'opened' });
    expect(c.spies).toEqual({ run: 1, release: 0 });
    expect(t.asks()).toEqual([]);
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

  it('ask with no app and no owner opens a wait on NO_OWNER_WINDOW and expires at its budget', async () => {
    const t = setup();
    t.owners.set(CALLER, null);
    t.state.appUp = false;
    const c = t.call();
    await t.flush();
    expect(t.asks()).toHaveLength(1);
    expect(t.flow.answer('perm-1', 1, 'approve')).toBe(false);
    t.advance(ASK_TIMEOUT_MS.claude - 1);
    await t.flush();
    expect(c.out.done).toBe(false);
    t.advance(1);
    expect(errCode(await c.promise)).toBe('approval_timeout');
    expect(c.spies).toEqual({ run: 0, release: 0 });
    expect(t.closed()).toEqual([{ type: 'mcp:askClosed', askId: 'perm-1', outcome: 'expired' }]);
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
    t.policies.set(CALLER, { ...ASK, decision: 'deny' });
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
