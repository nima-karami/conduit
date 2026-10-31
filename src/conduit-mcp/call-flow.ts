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
import type { AskAnswer } from './ui-types';
import { type CallKey, createWindowWaits } from './window-waits';

/** Below each CLI's documented MCP call timeout (spec §5, research 2026-10-30). */
export const ASK_TIMEOUT_MS: Readonly<Record<CliKind, number>> = {
  claude: 120_000,
  codex: 50_000,
  cursor: 50_000,
  opencode: 25_000,
  agent: 25_000,
};
export const MAX_ASKS_PER_CALLER = 3;

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
      ASK_TIMEOUT_MS[c.kind],
    );
    deps.flashOwner(caller);
    deps.onAwaitingChanged();

    const end = await ended;
    deps.onAwaitingChanged();
    // Unanswered ends keep the rate token: it caps card spam (spec §3.3 "Rate").
    switch (end.kind) {
      case 'expired':
        return {
          ok: false,
          error: toolError('approval_timeout', 'the human did not answer in time'),
        };
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

  /** The wait's key; begin() registered it, so the in-flight object knows its own key. */
  const keys = new WeakMap<InFlight, CallKey>();
  const keyOf = (f: InFlight): CallKey => {
    const k = keys.get(f);
    if (!k) throw new Error('call-flow: an InFlight from another flow');
    return k;
  };

  const cancelWaits = (match: (w: { callerSessionId: string; windowId: number }) => boolean) =>
    waits.cancel(match, true);

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
      keys.set(entry, key);
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
      waits.cancel((w) => w.key.connId === connId && w.key.requestId === requestId, false);
    },

    connectionClosed(connId) {
      for (const entry of inflight.get(connId)?.values() ?? []) entry.cancelled = true;
      inflight.delete(connId);
      waits.cancel((w) => w.key.connId === connId, false);
    },

    sessionGone: (sessionId) => {
      cancelWaits((w) => w.callerSessionId === sessionId);
    },
    sessionMoved: (sessionId) => {
      cancelWaits((w) => w.callerSessionId === sessionId);
    },
    windowReset: (windowId) => {
      cancelWaits((w) => w.windowId === windowId);
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

    awaitingApproval: () => [...new Set(waits.pending().map((w) => w.callerSessionId))],

    dispose() {
      waits.dispose();
      inflight.clear();
    },
  };
}
