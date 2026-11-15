// Node-free. The control-call pipeline after the gate: in-flight tracking for MCP cancellation,
// prepare → (ask) → run, and every way an ask can end (plan 2026-10-30-conduit-mcp-tool-policy,
// call-flow contract). The host only wires it.
import type { HostToWebview } from '../protocol';
import type { Prepared, PreparedCall } from './control-tools';
import type { GrantChoice } from './grant-store';
import type { JsonRpcId } from './json-rpc';
import type {
  OneUseOverride,
  PermissionAnswer,
  PolicyDecision,
  PolicyTarget,
} from './policy-types';
import type { AnswerInput } from './request-types';
import {
  type CliKind,
  type PolicySource,
  type ToolName,
  toolDisabled,
  windowNotReady,
} from './tool-policy';
import { type Handle, type Result, toolError } from './types';
import {
  type AskAnswer,
  MAX_CLOSE_RESULTS,
  MAX_UI_FAILURE_CHARS,
  MAX_UNSAVED_PATHS,
  type McpUiAction,
  type McpUiResult,
} from './ui-types';
import { type CallKey, createWindowWaits } from './window-waits';

/** Below each CLI's documented MCP call timeout (spec §5, research 2026-10-30). */
export const ASK_TIMEOUT_MS: Readonly<Record<CliKind, number>> = {
  claude: 120_000,
  codex: 50_000,
  cursor: 50_000,
  opencode: 25_000,
  agent: 25_000,
};
/**
 * A Conduit launch gives codex tool_timeout_sec=180, so its card can wait longer; a plain-shell
 * codex may be running a v0.50 entry with the 60 s default (spec 2026-10-31-conduit-mcp-single-gate).
 */
const CODEX_WIRED_ASK_TIMEOUT_MS = 170_000;
export function askBudgetMs(kind: CliKind, wiredAtLaunch: boolean): number {
  return kind === 'codex' && wiredAtLaunch ? CODEX_WIRED_ASK_TIMEOUT_MS : ASK_TIMEOUT_MS[kind];
}
export const MAX_ASKS_PER_CALLER = 3;
/** Presence ids start at 1, so 0 is never a real window. */
export const NO_OWNER_WINDOW = 0;
/** An app-control tool's renderer step (spec 2026-10-30-conduit-mcp-app-control §2.3). */
export const UI_TIMEOUT_MS = 5_000;
/** What an ask holds back from its CLI budget so the reply lands first. Waits use WAIT_REPLY_MARGIN_MS instead (session-waits.ts). */
const askMarginMs = (routesUi: boolean): number => (routesUi ? UI_TIMEOUT_MS : 0);

export interface InFlight {
  /** True once notifications/cancelled named this request. Never true for a null requestId. */
  readonly cancelled: boolean;
  /** Drops the in-flight entry; called in the host's finally. Idempotent. */
  end(): void;
}
export interface AskCommit {
  decision: PolicyDecision;
  held: readonly OneUseOverride[];
}
export type AnswerDecision = { kind: 'ready' } | { kind: 'withdraw'; reason: string };
export type GrantOutcome = 'made' | 'session-gone' | 'scope';
export interface ControlCall<T> {
  inflight: InFlight;
  caller: { sessionId: string; handle: Handle };
  kind: CliKind;
  /** The session runs a Conduit launch whose CLI args carry Conduit's MCP wiring. */
  wiredAtLaunch: boolean;
  tool: ToolName;
  decision: PolicyDecision;
  commit(): AskCommit | null;
  permission: { why: string; targets: readonly PolicyTarget[] };
  denyReason(held: readonly OneUseOverride[]): string | null;
  reDecide(held: readonly OneUseOverride[]): AnswerDecision;
  grant(choice: GrantChoice, requestId: string): GrantOutcome;
  commitAnswered(held: readonly OneUseOverride[]): boolean;
  /** Only for the card's reason line: the gate reads decision, never source. */
  source: PolicySource;
  args: unknown;
  prepare(): Promise<Result<Prepared<T>>>;
}
export interface PermissionRaise {
  inflight: InFlight;
  caller: { sessionId: string; handle: Handle };
  tool: ToolName;
  args: unknown;
  why: string;
  targets: readonly PolicyTarget[];
  expiresAt: number;
}
export interface PermissionEnd {
  requestId: string;
  caller: { sessionId: string; handle: Handle };
  tool: ToolName;
  end: 'answered' | 'withdrawn';
  answer: AnswerInput | null;
  reason: string | null;
}
export interface CallFlowDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  newAskId(): string;
  ownerWindowOf(sessionId: string): number | null;
  appConnected(): boolean;
  sendToOwner(sessionId: string, msg: HostToWebview): void;
  flashOwner(sessionId: string): void;
  // see plan T2.3 call-flow seam ruling (visibility is pure)
  stillVisible(sessionId: string, tool: ToolName): boolean;
  messagingOn(): boolean;
  openPermission(r: PermissionRaise): string;
  settlePermission(e: PermissionEnd): void;
  /** The waiting set changed: the host re-broadcasts mcp:state. */
  onAwaitingChanged(): void;
  /** Sends to one window by id; main guards isDestroyed. May still throw. */
  sendToWindow(windowId: number, msg: HostToWebview): void;
  /** presence.isReady for a window id. */
  windowReady(windowId: number): boolean;
}
interface UiRequest {
  inflight: InFlight;
  callerSessionId: string;
  /** closeSession's target, else the caller: its move or close ends the wait too. */
  routedSessionId: string;
  windowId: number;
  action: McpUiAction;
}
export interface CallFlow {
  /** Synchronous; must run before the caller's first await. A null requestId is not tracked. */
  begin(key: CallKey): InFlight;
  /** After the gate. null ⇒ no reply (the CLI cancelled). */
  runControl<T>(c: ControlCall<T>): Promise<Result<T> | null>;
  /** notifications/cancelled: marks the in-flight entry and ends its ask (reply false). */
  cancelled(connId: number, requestId: JsonRpcId): void;
  /** The connection's asks end and its in-flight calls are marked cancelled; nothing to reply to. */
  connectionClosed(connId: number): void;
  /** The caller's asks end, reply true. */
  sessionGone(sessionId: string): void;
  /** The caller's asks end, reply true. */
  sessionMoved(sessionId: string): void;
  /** Asks shown in that window end, reply true. */
  windowReset(windowId: number): void;
  /**
   * A waiting ask ends once its tool stops being visible to its caller, or all of them when
   * messaging is off.
   */
  recheck(): void;
  /** false unless the ask exists, is waiting, and `fromWindowId` is its window. */
  answer(askId: string, fromWindowId: number, answer: AskAnswer): boolean;
  answerPermission(askId: string, answer: PermissionAnswer, fromWindowId: number): boolean;
  /**
   * Sends mcp:ui to `windowId` and waits ≤ UI_TIMEOUT_MS for that window's answer. Keyed by the
   * in-flight's call key, so every cancel path ends it. An unready window or a throwing send ⇒
   * window_not_ready with no wait left pending; expired ⇒ ui_timeout; cancelled ⇒ window_not_ready.
   */
  requestUi(r: UiRequest): Promise<Result<McpUiResult>>;
  /** false unless the request is waiting, `fromWindowId` is its window, and `raw` parses for its kind. */
  answerUi(requestId: string, fromWindowId: number, raw: unknown): boolean;
  awaitingApproval(): string[];
  waitingAskCount(): number;
  dispose(): void;
}

interface AskMeta {
  tool: ToolName;
  handle: Handle;
  /** The reason the policy now denies this ask, or null while it does not. Pure. */
  denyReason: () => string | null;
}
interface Entry extends InFlight {
  cancelled: boolean;
}
interface UiMeta {
  kind: McpUiAction['kind'];
  routedSessionId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const approvalTimeout = () => toolError('approval_timeout', 'the human did not answer in time');
const ALWAYS_GRANT: GrantChoice = { who: 'session', on: 'anywhere', for: 'session-end' };
const cardAnswer = (a: AskAnswer): PermissionAnswer =>
  a === 'approve'
    ? { outcome: 'allowed' }
    : a === 'deny'
      ? { outcome: 'denied' }
      : { outcome: 'allowed', grant: ALWAYS_GRANT };
const answerInputOf = (a: PermissionAnswer): AnswerInput =>
  a.outcome === 'allowed'
    ? a.grant === undefined
      ? { outcome: 'allowed' }
      : { outcome: 'allowed', grant: a.grant }
    : a.reason === undefined
      ? { outcome: 'denied' }
      : { outcome: 'denied', reason: a.reason };
const SKIP_REASONS: ReadonlySet<unknown> = new Set(['unsaved', 'not_open']);

/** A renderer failure message reaches an agent's terminal: no escape sequences, C0 or C1
 *  controls (tab and newline stay readable). */
function withoutControls(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/** The human's reason reaches the agent through the same control-character filter as renderer text. */
function declinedMessage(reason: string | undefined): string {
  const text = reason === undefined ? '' : withoutControls(reason);
  return text === '' ? 'the human declined the request' : `the human declined the request: ${text}`;
}

/** The renderer is never load-bearing: its answer is rebuilt field by field for the wait's kind. */
function parseUiResult(kind: McpUiAction['kind'], v: unknown): McpUiResult | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'unknownSession') return { kind: 'unknownSession' };
  if (v.kind === 'failed')
    return typeof v.message === 'string'
      ? { kind: 'failed', message: withoutControls(v.message).slice(0, MAX_UI_FAILURE_CHARS) }
      : null;
  switch (kind) {
    case 'closeSession':
      if (v.kind !== 'closeSession') return null;
      if (v.ok === true) return { kind: 'closeSession', ok: true };
      if (
        v.ok === false &&
        isStrings(v.unsaved) &&
        v.unsaved.length >= 1 &&
        v.unsaved.length <= MAX_UNSAVED_PATHS
      )
        return { kind: 'closeSession', ok: false, unsaved: [...v.unsaved] };
      return null;
    case 'closeFiles': {
      if (v.kind !== 'closeFiles' || !isStrings(v.closed) || !Array.isArray(v.skipped)) return null;
      const skipped: { path: string; reason: 'unsaved' | 'not_open' }[] = [];
      for (const x of v.skipped) {
        if (!isRecord(x) || typeof x.path !== 'string' || !SKIP_REASONS.has(x.reason)) return null;
        skipped.push({ path: x.path, reason: x.reason === 'unsaved' ? 'unsaved' : 'not_open' });
      }
      if (v.closed.length + skipped.length > MAX_CLOSE_RESULTS) return null;
      if (v.truncated !== undefined && v.truncated !== true) return null;
      return {
        kind: 'closeFiles',
        closed: [...v.closed],
        skipped,
        ...(v.truncated ? { truncated: true as const } : {}),
      };
    }
    case 'openReview':
    case 'openGitHistory':
    case 'openUrl':
      return v.kind === 'opened' ? { kind: 'opened' } : null;
  }
}

export function createCallFlow(deps: CallFlowDeps): CallFlow {
  /** By connId, then requestId: a Map keeps 1 and '1' apart, as JSON-RPC does. */
  const inflight = new Map<number, Map<JsonRpcId, Entry>>();
  const waits = createWindowWaits<PermissionAnswer, AskMeta>({
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    onUnanswered: (w, end) =>
      deps.sendToOwner(w.callerSessionId, {
        type: 'mcp:askClosed',
        askId: w.id,
        outcome: end.kind,
      }),
  });

  /** Asks an unshown policy denial ended; their call reports tool_disabled with the reason. */
  const denied = new Map<string, string>();
  const waitsUi = createWindowWaits<McpUiResult, UiMeta>({
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    // The renderer keeps no per-request state to clear.
    onUnanswered: () => {},
  });

  async function runNow<T>(c: ControlCall<T>, p: PreparedCall<T>): Promise<Result<T> | null> {
    const r = await p.run();
    return c.inflight.cancelled ? null : r;
  }

  async function ask<T>(c: ControlCall<T>, p: PreparedCall<T>): Promise<Result<T> | null> {
    const caller = c.caller.sessionId;
    const key = keyOf(c.inflight);
    // One synchronous block from the cap check to waits.open: an await here would let two calls
    // pass the cap together (plan, Global constraints).
    if (waits.countFor(caller) >= MAX_ASKS_PER_CALLER) {
      p.release();
      return {
        ok: false,
        error: toolError('rate_limited', 'more than 3 requests are waiting for the human'),
      };
    }
    const windowId = deps.ownerWindowOf(caller) ?? (deps.appConnected() ? null : NO_OWNER_WINDOW);
    if (windowId === null) {
      p.release();
      return { ok: false, error: windowNotReady() };
    }
    // Ask + UI wait must both fit inside the CLI's own call timeout, which started at begin(), not
    // after prepare's git calls (plan B11).
    const askMs =
      startOf(c.inflight) +
      askBudgetMs(c.kind, c.wiredAtLaunch) -
      askMarginMs(p.routesUi) -
      deps.now();
    if (askMs <= 0) {
      p.release();
      return { ok: false, error: approvalTimeout() };
    }
    const committed = c.commit();
    if (committed === null) {
      p.release();
      return { ok: false, error: toolDisabled(c.tool) };
    }
    // The card guards a decision that is still an ask; a recovered allow has nothing to guard.
    if (committed.decision.decision === 'allow' && !p.alwaysAsk) return runNow(c, p);
    const requestId = deps.openPermission({
      inflight: c.inflight,
      caller: c.caller,
      tool: c.tool,
      args: c.args,
      why: c.permission.why,
      targets: c.permission.targets,
      expiresAt: deps.now() + askMs,
    });
    const held = committed.held;
    const settle = (
      end: PermissionEnd['end'],
      answer: AnswerInput | null,
      reason: string | null,
    ): void =>
      deps.settlePermission({ requestId, caller: c.caller, tool: c.tool, end, answer, reason });
    deps.sendToOwner(caller, {
      type: 'mcp:ask',
      askId: requestId,
      callerSessionId: caller,
      callerHandle: c.caller.handle,
      tool: c.tool,
      summary: p.summary,
      args: c.args,
      source: c.source,
    });
    const ended = waits.open(
      {
        id: requestId,
        callerSessionId: caller,
        key,
        windowId,
        meta: {
          tool: c.tool,
          handle: c.caller.handle,
          denyReason: () => c.denyReason(held),
        },
      },
      askMs,
    );
    deps.flashOwner(caller);
    deps.onAwaitingChanged();

    const end = await ended;
    deps.onAwaitingChanged();
    // Unanswered ends keep the rate token: it caps card spam (spec §3.3 "Rate").
    switch (end.kind) {
      case 'expired':
        return { ok: false, error: approvalTimeout() };
      case 'cancelled': {
        const deny = denied.get(requestId);
        denied.delete(requestId);
        if (deny !== undefined) {
          settle('withdrawn', null, deny);
          return { ok: false, error: toolError('tool_disabled', deny) };
        }
        settle('withdrawn', null, 'the call was cancelled');
        return end.reply
          ? { ok: false, error: toolError('cancelled', 'the request was cancelled') }
          : null;
      }
      case 'answered':
        break;
    }
    const answer = end.answer;
    if (answer.outcome === 'denied') {
      settle('answered', answerInputOf(answer), null);
      return { ok: false, error: toolError('denied', declinedMessage(answer.reason)) };
    }
    // Approved, then cancelled before it ran: still a cancelled ask, so the token stays spent.
    if (c.inflight.cancelled) {
      settle('withdrawn', null, 'the call was cancelled');
      return null;
    }
    const decided = c.reDecide(held);
    if (decided.kind === 'withdraw') {
      settle('withdrawn', null, decided.reason);
      return { ok: false, error: toolError('tool_disabled', decided.reason) };
    }
    if (answer.grant !== undefined) {
      const made = c.grant(answer.grant, requestId);
      if (made !== 'made') {
        const why =
          made === 'session-gone'
            ? 'the session closed before the request ran'
            : "that scope isn't available for every target";
        settle('withdrawn', null, why);
        return { ok: false, error: toolError('cancelled', why) };
      }
    }
    if (!c.commitAnswered(held)) {
      settle('withdrawn', null, 'the policy changed while the request waited');
      return { ok: false, error: toolDisabled(c.tool) };
    }
    settle('answered', answerInputOf(answer), null);
    return runNow(c, p);
  }

  /** The wait's key and start; begin() registered them, so the in-flight object knows its own. */
  const keys = new WeakMap<InFlight, { key: CallKey; startedAt: number }>();
  const begun = (f: InFlight) => {
    const k = keys.get(f);
    if (!k) throw new Error('call-flow: an InFlight from another flow');
    return k;
  };
  const keyOf = (f: InFlight): CallKey => begun(f).key;
  const startOf = (f: InFlight): number => begun(f).startedAt;

  const cancelWaits = (match: (w: { callerSessionId: string; windowId: number }) => boolean) =>
    waits.cancel(match, true);
  const cancelSessionWaits = (sessionId: string) => {
    cancelWaits((w) => w.callerSessionId === sessionId);
    waitsUi.cancel(
      (w) => w.callerSessionId === sessionId || w.meta.routedSessionId === sessionId,
      true,
    );
  };
  const sameCall =
    (key: { connId: number; requestId: JsonRpcId }) =>
    (w: { key: { connId: number; requestId: JsonRpcId | null } }) =>
      w.key.connId === key.connId && w.key.requestId === key.requestId;

  async function requestUi(r: UiRequest): Promise<Result<McpUiResult>> {
    if (!deps.windowReady(r.windowId)) return { ok: false, error: windowNotReady() };
    const requestId = deps.newAskId();
    const ended = waitsUi.open(
      {
        id: requestId,
        callerSessionId: r.callerSessionId,
        key: keyOf(r.inflight),
        windowId: r.windowId,
        meta: { kind: r.action.kind, routedSessionId: r.routedSessionId },
      },
      UI_TIMEOUT_MS,
    );
    try {
      deps.sendToWindow(r.windowId, {
        type: 'mcp:ui',
        requestId,
        sessionId: r.callerSessionId,
        action: r.action,
      });
    } catch {
      // A window torn down between the ready check and the send: nothing reached it, so the call
      // is refused like an unready window rather than left to time out (plan, Global constraints).
      waitsUi.cancel((w) => w.id === requestId, true);
      await ended;
      return { ok: false, error: windowNotReady() };
    }
    const end = await ended;
    switch (end.kind) {
      case 'answered':
        return { ok: true, value: end.answer };
      case 'expired':
        return {
          ok: false,
          error: toolError(
            'ui_timeout',
            "Conduit's window didn't answer within 5 s; the outcome is unknown",
          ),
        };
      case 'cancelled':
        return {
          ok: false,
          error: toolError(
            'window_not_ready',
            "Conduit's window closed or reloaded before answering; the outcome is unknown",
          ),
        };
    }
  }

  return {
    begin(key) {
      const entry: Entry = {
        cancelled: false,
        end() {
          if (key.requestId === null) return;
          const byId = inflight.get(key.connId);
          if (byId?.get(key.requestId) !== entry) return;
          byId.delete(key.requestId);
          if (byId.size === 0) inflight.delete(key.connId);
        },
      };
      keys.set(entry, { key, startedAt: deps.now() });
      if (key.requestId !== null) {
        let byId = inflight.get(key.connId);
        if (!byId) {
          byId = new Map();
          inflight.set(key.connId, byId);
        }
        byId.set(key.requestId, entry);
      }
      return entry;
    },

    async runControl(c) {
      const prepared = await c.prepare();
      if (!prepared.ok) return prepared;
      const p = prepared.value;
      // Prepare answered without taking a reservation, so nothing to release; a deny still refuses.
      if ('done' in p) {
        if (c.decision.decision === 'deny') return { ok: false, error: toolDisabled(c.tool) };
        if (c.inflight.cancelled) return null;
        if (c.commit() === null) return { ok: false, error: toolDisabled(c.tool) };
        return p.done;
      }
      if (c.inflight.cancelled) {
        p.release();
        return null;
      }
      // A bare command is not a registered agent, so an allow still asks
      // (flexible-agent-contracts §3.1).
      const access = p.alwaysAsk && c.decision.decision === 'allow' ? 'ask' : c.decision.decision;
      switch (access) {
        case 'allow':
          if (c.commit() === null) {
            p.release();
            return { ok: false, error: toolDisabled(c.tool) };
          }
          return runNow(c, p);
        case 'ask':
          return ask(c, p);
        case 'deny':
          p.release();
          return { ok: false, error: toolDisabled(c.tool) };
      }
    },

    cancelled(connId, requestId) {
      const entry = inflight.get(connId)?.get(requestId);
      if (!entry) return;
      entry.cancelled = true;
      const match = sameCall({ connId, requestId });
      waits.cancel(match, false);
      waitsUi.cancel(match, false);
    },

    connectionClosed(connId) {
      for (const entry of inflight.get(connId)?.values() ?? []) entry.cancelled = true;
      inflight.delete(connId);
      waits.cancel((w) => w.key.connId === connId, false);
      waitsUi.cancel((w) => w.key.connId === connId, false);
    },

    sessionGone: cancelSessionWaits,
    sessionMoved: cancelSessionWaits,
    windowReset: (windowId) => {
      cancelWaits((w) => w.windowId === windowId);
      waitsUi.cancel((w) => w.windowId === windowId, true);
    },

    recheck() {
      if (!deps.messagingOn()) {
        cancelWaits(() => true);
        return;
      }
      waits.cancel((w) => {
        if (deps.stillVisible(w.callerSessionId, w.meta.tool)) return false;
        const reason = w.meta.denyReason();
        if (reason !== null) denied.set(w.id, reason);
        return true;
      }, true);
    },

    answer: (askId, fromWindowId, answer) => waits.answer(askId, fromWindowId, cardAnswer(answer)),

    answerPermission(askId, answer, fromWindowId) {
      if (fromWindowId === NO_OWNER_WINDOW) return false;
      const w = waits.pending().find((x) => x.id === askId);
      if (w === undefined || !waits.answer(askId, fromWindowId, answer)) return false;
      deps.sendToOwner(w.callerSessionId, { type: 'mcp:askClosed', askId, outcome: 'answered' });
      return true;
    },

    requestUi,

    answerUi(requestId, fromWindowId, raw) {
      const w = waitsUi.pending().find((x) => x.id === requestId);
      if (!w) return false;
      const parsed = parseUiResult(w.meta.kind, raw);
      if (parsed === null) return false;
      return waitsUi.answer(requestId, fromWindowId, parsed);
    },

    awaitingApproval: () => [...new Set(waits.pending().map((w) => w.callerSessionId))],
    waitingAskCount: () => waits.pending().length,

    dispose() {
      waits.dispose();
      waitsUi.dispose();
      inflight.clear();
    },
  };
}
