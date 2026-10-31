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
  const closed = asks.find((a) => a.askId === m.askId);
  if (!closed) return;
  setAsks(asks.filter((a) => a.askId !== m.askId));
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
  if (!asks.some((a) => a.askId === askId)) return;
  post({ type: 'mcp:askAnswer', askId, answer });
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
