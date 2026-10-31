// Node-free. The control-call pipeline after the gate: in-flight tracking for MCP cancellation,
// prepare → (ask) → run, and every way an ask can end (plan 2026-10-30-conduit-mcp-tool-policy,
// call-flow contract). The host only wires it.
import type { HostToWebview } from '../protocol';
import type { PreparedCall } from './control-tools';
import type { JsonRpcId } from './json-rpc';
import {
  type CliKind,
  type PolicySource,
  type ToolName,
  type ToolPolicy,
  type ToolPolicyPatch,
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
/** An app-control tool's renderer step (spec 2026-10-30-conduit-mcp-app-control §2.3). */
export const UI_TIMEOUT_MS = 5_000;

export interface InFlight {
  /** True once notifications/cancelled named this request. Never true for a null requestId. */
  readonly cancelled: boolean;
  /** Drops the in-flight entry; called in the host's finally. Idempotent. */
  end(): void;
}
export interface ControlCall<T> {
  inflight: InFlight;
  caller: { sessionId: string; handle: Handle };
  kind: CliKind;
  /** The session runs a Conduit launch whose CLI args carry Conduit's MCP wiring. */
  wiredAtLaunch: boolean;
  tool: ToolName;
  policy: ToolPolicy;
  /** The layer that set `access` (for the card's reason line). */
  source: PolicySource;
  args: unknown;
  prepare(): Promise<Result<PreparedCall<T>>>;
}
export interface CallFlowDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  newAskId(): string;
  ownerWindowOf(sessionId: string): number | null;
  sendToOwner(sessionId: string, msg: HostToWebview): void;
  flashOwner(sessionId: string): void;
  /** Current resolved policy for a waiting ask's caller and tool; null when the session is gone. */
  resolve(sessionId: string, tool: ToolName): ToolPolicy | null;
  messagingOn(): boolean;
  /** false when the session no longer exists. */
  setSessionPolicy(sessionId: string, tool: ToolName, patch: ToolPolicyPatch): boolean;
  /** After Always wrote the session layer: the host re-syncs tool lists. */
  onPolicyWritten(): void;
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
  /** Ends (reply true) every ask whose re-resolved access is 'off', or all when messaging is off. */
  recheck(): void;
  /** false unless the ask exists, is waiting, and `fromWindowId` is its window. */
  answer(askId: string, fromWindowId: number, answer: AskAnswer): boolean;
  /**
   * Sends mcp:ui to `windowId` and waits ≤ UI_TIMEOUT_MS for that window's answer. Keyed by the
   * in-flight's call key, so every cancel path ends it. An unready window or a throwing send ⇒
   * window_not_ready with no wait left pending; expired ⇒ ui_timeout; cancelled ⇒ window_not_ready.
   */
  requestUi(r: UiRequest): Promise<Result<McpUiResult>>;
  /** false unless the request is waiting, `fromWindowId` is its window, and `raw` parses for its kind. */
  answerUi(requestId: string, fromWindowId: number, raw: unknown): boolean;
  awaitingApproval(): string[];
  dispose(): void;
}

interface AskMeta {
  tool: ToolName;
  handle: Handle;
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
  const waits = createWindowWaits<AskAnswer, AskMeta>({
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
    const windowId = deps.ownerWindowOf(caller);
    if (windowId === null) {
      p.release();
      return { ok: false, error: windowNotReady() };
    }
    // Ask + UI wait must both fit inside the CLI's own call timeout, which started at begin(), not
    // after prepare's git calls (plan B11).
    const askMs =
      startOf(c.inflight) +
      askBudgetMs(c.kind, c.wiredAtLaunch) -
      (p.routesUi ? UI_TIMEOUT_MS : 0) -
      deps.now();
    if (askMs <= 0) {
      p.release();
      return { ok: false, error: approvalTimeout() };
    }
    const askId = deps.newAskId();
    deps.sendToOwner(caller, {
      type: 'mcp:ask',
      askId,
      callerSessionId: caller,
      callerHandle: c.caller.handle,
      tool: c.tool,
      summary: p.summary,
      args: c.args,
      source: c.source,
    });
    const ended = waits.open(
      {
        id: askId,
        callerSessionId: caller,
        key,
        windowId,
        meta: { tool: c.tool, handle: c.caller.handle },
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
      case 'cancelled':
        return end.reply
          ? { ok: false, error: toolError('cancelled', 'the request was cancelled') }
          : null;
      case 'answered':
        break;
    }
    if (end.answer === 'deny')
      return { ok: false, error: toolError('denied', 'the human declined the request') };
    if (end.answer === 'always') {
      // spec D2: a persistent session override; the session may have closed while the card waited.
      if (!deps.setSessionPolicy(caller, c.tool, { access: 'on' }))
        return {
          ok: false,
          error: toolError('cancelled', 'the session closed before the request ran'),
        };
      deps.onPolicyWritten();
    }
    // Approved, then cancelled before it ran: still a cancelled ask, so the token stays spent.
    if (c.inflight.cancelled) return null;
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
      if (c.inflight.cancelled) {
        p.release();
        return null;
      }
      switch (c.policy.access) {
        case 'on':
          return runNow(c, p);
        case 'ask':
          return ask(c, p);
        case 'off':
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
        const now = deps.resolve(w.callerSessionId, w.meta.tool);
        return now === null || now.access === 'off';
      }, true);
    },

    answer: (askId, fromWindowId, answer) => waits.answer(askId, fromWindowId, answer),

    requestUi,

    answerUi(requestId, fromWindowId, raw) {
      const w = waitsUi.pending().find((x) => x.id === requestId);
      if (!w) return false;
      const parsed = parseUiResult(w.meta.kind, raw);
      if (parsed === null) return false;
      return waitsUi.answer(requestId, fromWindowId, parsed);
    },

    awaitingApproval: () => [...new Set(waits.pending().map((w) => w.callerSessionId))],

    dispose() {
      waits.dispose();
      waitsUi.dispose();
      inflight.clear();
    },
  };
}
