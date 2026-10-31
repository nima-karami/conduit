import { useSyncExternalStore } from 'react';
import type { PolicySource, ToolName } from '../src/conduit-mcp/tool-policy';
import type { Handle } from '../src/conduit-mcp/types';
import type { AskAnswer, AskSummary } from '../src/conduit-mcp/ui-types';
import { post, subscribe } from './bridge';
import { MCP_STR } from './conduit-mcp-strings';
import { pushToast } from './toast-store';

export interface PendingAskView {
  askId: string;
  callerSessionId: string;
  callerHandle: Handle;
  tool: ToolName;
  summary: AskSummary;
  args: unknown;
  source: PolicySource;
}

// A module singleton like use-conduit-mcp.ts: an ask can arrive before the card mounts. A reload
// starts empty, which is right — the host cancels every ask of a reloading window.
let asks: readonly PendingAskView[] = [];
const listeners = new Set<() => void>();
const focusListeners = new Set<() => void>();
// Answered here but possibly ended at the host first (expiry or cancel racing the answer): the
// askClosed that follows must still be told. An answer that won gets no askClosed, so the oldest
// entries age out by count; a racing askClosed lands within one round trip of its answer.
const answered = new Map<string, PendingAskView>();
const ANSWERED_KEPT = 64;

function setAsks(next: readonly PendingAskView[]): void {
  asks = next;
  listeners.forEach((l) => {
    l();
  });
}

subscribe((m) => {
  if (m.type === 'mcp:ask') {
    const { type: _type, ...view } = m;
    setAsks([...asks, view]);
    return;
  }
  if (m.type !== 'mcp:askClosed') return;
  const waiting = asks.find((a) => a.askId === m.askId);
  const closed = waiting ?? answered.get(m.askId);
  if (!closed) return;
  answered.delete(m.askId);
  if (waiting) setAsks(asks.filter((a) => a.askId !== m.askId));
  const message =
    m.outcome === 'expired'
      ? MCP_STR.ask.expired(closed.callerHandle)
      : MCP_STR.ask.cancelled(closed.callerHandle);
  pushToast({ message, variant: 'info' });
});

/** Oldest first. */
export function getAsksSnapshot(): readonly PendingAskView[] {
  return asks;
}

export function subscribeAsks(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useAsks(): readonly PendingAskView[] {
  return useSyncExternalStore(subscribeAsks, getAsksSnapshot);
}

/** Posts mcp:askAnswer and drops the ask locally. */
export function answerAsk(askId: string, answer: AskAnswer): void {
  const ask = asks.find((a) => a.askId === askId);
  if (!ask) return;
  post({ type: 'mcp:askAnswer', askId, answer });
  answered.set(askId, ask);
  if (answered.size > ANSWERED_KEPT) {
    const oldest = answered.keys().next();
    if (!oldest.done) answered.delete(oldest.value);
  }
  setAsks(asks.filter((a) => a.askId !== askId));
}

export function requestAskFocus(): void {
  focusListeners.forEach((l) => {
    l();
  });
}

export function subscribeAskFocus(cb: () => void): () => void {
  focusListeners.add(cb);
  return () => {
    focusListeners.delete(cb);
  };
}
